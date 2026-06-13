import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { ClientTvCancellationRepository } from '@domain/ports/ClientTvCancellationRepository';
import type { ClientTvActivationRepository } from '@domain/ports/ClientTvActivationRepository';
import type { TvActivationEventRepository } from '@domain/ports/TvActivationEventRepository';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { GrClientIdRequiredError } from '@domain/errors/gigared';
import { currentTvInternalId } from '@domain/gigared/tvIdentity';
import { deterministicTvEmail, deterministicTvPassword, isValidGigaredPassword } from '@infrastructure/security/gigaredPassword';
import type { CustomerLookup, ContractLookup } from './lookups';
import { reconcileTvContractService } from './reconcileTvContractService';

/**
 * The Gigared Play login impacted on the local TV row (#65): `GIGA{abonado}`,
 * where `abonado` is the account's gigaredId (crm.gigared_id). Falls back to the
 * `ott.id` (already `GIGA{abonado}`) when gigaredId is absent.
 */
export function tvLoginFromAccount(account: GigaredAccount): string | null {
  if (account.gigaredId) return `GIGA${account.gigaredId}`;
  if (account.ott?.id) return account.ott.id;
  return null;
}

/**
 * RegisterGigaredAccount (#47 / #72) — registers a brand-new Gigared account for a CIC,
 * activates it, binds internal_id = customerId, then returns the account.
 * The register password is TRANSIT-ONLY toward Gigared.
 *
 * #65 — when a `contractId` is supplied (and the reconcile deps are present), after the
 * account is linked the use case reconciles the local TV ContractService slot AND impacts
 * the deterministic credentials on it: `tvLogin = GIGA{abonado}` + `tvPassword = {password}`.
 * The credentials are visible to the operator by explicit product decision. Persistence is
 * BEST-EFFORT: a failure never aborts the (already-done) Gigared register — the account is
 * still returned. Without a `contractId` the behavior is byte-for-byte the legacy register.
 *
 * #72 — after the register + link succeeds, calls tvCancellation.clearCancelled(customerId)
 * best-effort so the local TV-cancel flag is cleared (the client got TV again). An error in
 * the clear never aborts the already-done Gigared register.
 *
 * #81 — identidad de TV SECUENCIAL por cliente. El partner QUEMA el internal_id y el mail al
 * primer uso, así que una RE-ALTA (cliente que venía de baja) no puede reusar el Client.id pelado
 * ni el mail de hoy. Cuando hay `activation` repo Y el cliente está cancelado (re-alta), se
 * incrementa el seq y se mintea una identidad fresca:
 *   - internal_id = currentTvInternalId(clientId, seq) → `{clientId}-{seq}` (nunca quemado)
 *   - email       = deterministicTvEmail(lastName, grClienteId, seq) → `{apellido}{grId}{seq}@gmail.com`
 * La primera alta (cliente no cancelado o sin activation repo) queda en seq=0 → identidad de hoy,
 * comportamiento byte-for-byte (back-compat): internal_id = Client.id pelado, mail el que mandó el FE.
 */
export class RegisterGigaredAccount {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly customerLookup: CustomerLookup,
    private readonly contractLookup?: ContractLookup,
    private readonly csRepo?: ContractServiceRepository,
    private readonly catalogRepo?: ServiceCatalogRepository,
    private readonly tvCancellation?: ClientTvCancellationRepository,
    private readonly activation?: ClientTvActivationRepository,
    /** #5 BE — optional event recorder (best-effort: failure never aborts the register). */
    private readonly eventRepo?: TvActivationEventRepository,
  ) {}

  async execute(
    customerId: string,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      cic: string;
      sendActivationEmail: boolean;
      /** #65 — owner contract for the local TV reconcile + credential persistence. */
      contractId?: string;
      /** #5 BE — actor who triggered this registration (from req.user at the route layer). */
      actorId?: string | null;
      actorName?: string;
    },
  ): Promise<{ account: GigaredAccount; credentialsPersisted: boolean }> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // #70 — the register password is generated SERVER-SIDE from the customer's grClienteId
    // (deterministic `ip{grClienteId}` padded, #65). The body no longer carries it. No
    // grClienteId → no source for the password → 422 GR_CLIENT_ID_REQUIRED, Gigared untouched.
    if (customer.grClienteId == null || customer.grClienteId === '') {
      throw new GrClientIdRequiredError(customerId);
    }
    const grClienteId: string = customer.grClienteId;
    const password = deterministicTvPassword(grClienteId);
    // Re-review #70: a grClienteId with chars outside [a-z0-9] would yield a non-CUA
    // password and an opaque 400 from the partner — fail LOCAL with the clear 422 instead.
    if (!isValidGigaredPassword(password)) {
      throw new GrClientIdRequiredError(customerId);
    }

    // #65 — validate ownership of the target contract BEFORE any Gigared write (mirror of
    // LinkCustomerToCic #47k). A foreign/absent contractId → 404, Gigared never touched.
    const wantsPersist =
      typeof input.contractId === 'string' && input.contractId !== '' &&
      !!this.csRepo && !!this.catalogRepo;
    if (wantsPersist && this.contractLookup) {
      const contract = await this.contractLookup.findById(input.contractId as string);
      if (!contract || contract.clientId !== customerId) {
        throw new ContractNotFoundError(input.contractId as string);
      }
    }

    // #81 — resolver el seq A USAR para esta alta. SOLO en re-alta (cliente que venía de baja y hay
    // activation repo) se incrementa el seq → identidad fresca. La primera alta queda en seq=0
    // (back-compat: internal_id pelado + el mail que mandó el FE). La señal honesta de "re-alta" es
    // el flag local de baja (#72): si está seteado, el partner ya quemó la identidad anterior.
    let seq = 0;
    if (this.activation && this.tvCancellation && (await this.tvCancellation.isCancelled(customerId))) {
      seq = await this.activation.incrementSeq(customerId);
    }
    const internalId = currentTvInternalId(customerId, seq);
    // #81 — en re-alta (seq>0) el mail lo genera el server con el seq (determinístico+recuperable,
    // visible en Credenciales #65). En la primera alta (seq=0) se respeta el mail del FE (back-compat).
    const email = seq > 0 ? deterministicTvEmail(input.lastName, grClienteId, seq) : input.email;

    await this.gigared.register({
      firstName: input.firstName,
      lastName: input.lastName,
      email,
      cic: input.cic,
      password,
      sendActivationEmail: input.sendActivationEmail,
    });
    await this.gigared.activate({ cic: input.cic, email });
    await this.gigared.setInternalId(input.cic, internalId);
    const account = await this.gigared.getAccountByInternalId(internalId);

    // #72 — clearCancelled best-effort: el cliente volvió a tener TV (re-registro exitoso).
    // Se intenta siempre que el register + link fue exitoso. Un error aquí NO aborta.
    if (this.tvCancellation) {
      try {
        await this.tvCancellation.clearCancelled(customerId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[gigared] register: TV cancellation flag clear failed (best-effort)', err);
      }
    }

    // #65 — persist credentials on the local TV slot. Best-effort: never abort the register.
    // H2/M8 fix: a fresh account comes back with services:[] → the reconcile would otherwise
    // create NO row and the credentials would vanish silently. We pass `ensureRow` so reconcile
    // creates/asegura the managed TV row (status inactive when there are no packs yet) and we
    // ALWAYS write the credentials onto it. M7: the result flags whether it actually persisted.
    let credentialsPersisted = false;
    if (wantsPersist && this.csRepo && this.catalogRepo) {
      try {
        const { contractServiceId } = await reconcileTvContractService({
          gigared: this.gigared,
          csRepo: this.csRepo,
          catalogRepo: this.catalogRepo,
          customerId,
          contractId: input.contractId as string,
          internalId,
          ensureRow: true,
        });
        if (contractServiceId) {
          await this.csRepo.update(contractServiceId, {
            tvLogin: tvLoginFromAccount(account),
            tvPassword: password,
          });
          credentialsPersisted = true;
        }
      } catch (err) {
        // Persistence is non-fatal — the Gigared register already succeeded.
        // eslint-disable-next-line no-console
        console.warn('[gigared] register: TV credential persistence failed (best-effort)', err);
        credentialsPersisted = false;
      }
    }

    // #5 BE — record the 'alta' / 'reactivacion' event best-effort. A failure here must NEVER
    // abort the already-completed Gigared register (same pattern as clearCancelled above).
    if (this.eventRepo) {
      try {
        await this.eventRepo.record({
          clientId:   customerId,
          actorId:    input.actorId ?? null,
          actorName:  input.actorName ?? '',
          eventType:  seq === 0 ? 'alta' : 'reactivacion',
          cic:        input.cic,
          internalId,
          seq,
          contractId: input.contractId ?? null,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[gigared] register: TV activation event record failed (best-effort)', err);
      }
    }

    return { account, credentialsPersisted };
  }
}

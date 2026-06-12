import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { GrClientIdRequiredError } from '@domain/errors/gigared';
import { deterministicTvPassword, isValidGigaredPassword } from '@infrastructure/security/gigaredPassword';
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
 * RegisterGigaredAccount (#47) — registers a brand-new Gigared account for a CIC,
 * activates it, binds internal_id = customerId, then returns the account.
 * The register password is TRANSIT-ONLY toward Gigared.
 *
 * #65 — when a `contractId` is supplied (and the reconcile deps are present), after the
 * account is linked the use case reconciles the local TV ContractService slot AND impacts
 * the deterministic credentials on it: `tvLogin = GIGA{abonado}` + `tvPassword = {password}`.
 * The credentials are visible to the operator by explicit product decision. Persistence is
 * BEST-EFFORT: a failure never aborts the (already-done) Gigared register — the account is
 * still returned. Without a `contractId` the behavior is byte-for-byte the legacy register.
 */
export class RegisterGigaredAccount {
  constructor(
    private readonly gigared: GigaredPort,
    private readonly customerLookup: CustomerLookup,
    private readonly contractLookup?: ContractLookup,
    private readonly csRepo?: ContractServiceRepository,
    private readonly catalogRepo?: ServiceCatalogRepository,
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
    const password = deterministicTvPassword(customer.grClienteId);
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

    await this.gigared.register({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      cic: input.cic,
      password,
      sendActivationEmail: input.sendActivationEmail,
    });
    await this.gigared.activate({ cic: input.cic, email: input.email });
    await this.gigared.setInternalId(input.cic, customerId);
    const account = await this.gigared.getAccountByInternalId(customerId);

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

    return { account, credentialsPersisted };
  }
}

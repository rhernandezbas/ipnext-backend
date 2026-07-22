import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { ClientTvCancellationRepository } from '@domain/ports/ClientTvCancellationRepository';
import type { ClientTvActivationRepository } from '@domain/ports/ClientTvActivationRepository';
import type { TvActivationEventRepository } from '@domain/ports/TvActivationEventRepository';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import {
  GrContractIdRequiredError,
  NoCicAvailableError,
  TvPoolPoisonedError,
  TvIdentityStampUnverifiedError,
  TvEmailOwnedByOtherError,
  GigaredNotFoundError,
  GigaredRejectedError,
} from '@domain/errors/gigared';
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
 *   - email       = deterministicTvEmail(lastName, grContratoId, seq) → `{apellido}{grId}{seq}@gmail.com`
 * #118 — la primera alta (seq=0) también deriva el email server-side del grContratoId.
 * El input.email del FE se ignora: la fuente única de identidad TV es grContratoId (email + password).
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
    /**
     * #109 — CIC selector for testability. Receives the pool length and returns the index
     * to use. Defaults to `Math.random()` weighted pick in production. Inject a deterministic
     * function in tests so the chosen CIC is predictable.
     */
    private readonly pick?: (poolLength: number) => number,
  ) {}

  /**
   * B2 (D2) — recovery/probe idempotente sobre el pool anti-envenenamiento (B1). Resuelve el
   * `cic`/`account` partner-side SIN tocar el reconcile local. Orden de guardas PINNED (spec/design
   * D2): probe -> pool-filter (B1) -> register-path -> post-stamp verify (B1) -> catch por
   * instancia (GigaredRejectedError) -> discriminador por email -> 3 ramas (resume/mía/ajena) +
   * rethrow. Extraído a helper para que cada rama termine en un `return` explícito — así el
   * compilador (no una convención frágil de banderas) garantiza que `cic`/`account` siempre quedan
   * asignados antes de usarse.
   */
  private async resolveGigaredAccount(
    internalId: string,
    email: string,
    password: string,
    input: { firstName: string; lastName: string; sendActivationEmail: boolean },
  ): Promise<{ cic: string; account: GigaredAccount; recovered: boolean }> {
    // D2 — probe previo: si el partner YA resuelve MI internal_id, este es un retry idempotente
    // sobre una cuenta ya estampada — NO tocar el pool ni re-registrar, solo reconciliar local.
    let probed: GigaredAccount | null = null;
    try {
      probed = await this.gigared.getAccountByInternalId(internalId);
    } catch (err) {
      if (!(err instanceof GigaredNotFoundError)) throw err;
    }
    if (probed) {
      return { cic: probed.cic, account: probed, recovered: true };
    }

    // 404 -> B1: pool-pick filtrado (anti-envenenamiento).
    const pool = await this.gigared.listAccounts({ status: 'unregistered' });
    if (pool.length === 0) throw new NoCicAvailableError();
    const clean = pool.filter(e => e.cic && (e.internalId === null || e.internalId === ''));
    if (clean.length === 0) throw new TvPoolPoisonedError(pool.length);
    const pickFn = this.pick ?? ((n: number) => Math.floor(Math.random() * n));
    const poolEntry = clean[pickFn(clean.length)];
    // FIX 1 / W2: guard cic falsy (cic === '' o undefined) y índice fuera de rango (poolEntry === undefined).
    // En ambos casos el error de dominio es NoCicAvailableError, no un TypeError opaco.
    if (!poolEntry?.cic) throw new NoCicAvailableError();
    let cic = poolEntry.cic;
    let recovered = false;

    try {
      await this.gigared.register({
        firstName: input.firstName,
        lastName: input.lastName,
        email,
        cic,
        password,
        sendActivationEmail: input.sendActivationEmail,
      });
    } catch (err) {
      if (!(err instanceof GigaredRejectedError)) throw err;
      // D2 — discriminador por email: register rechazó (duplicado). Buscamos quién es dueño hoy
      // del email determinístico para decidir si podemos reanudar, completar local, o rechazar.
      const matches = await this.gigared.listAccounts({ email });
      const match = matches[0];
      if (!match) throw err; // sin match -> re-lanzar el GIGARED_REJECTED original tal cual
      if (match.internalId === internalId) {
        // MÍA (ya estampada vía email) -> completar solo local; setInternalId NUNCA se llama.
        return { cic: match.cic, account: match, recovered: true };
      }
      if (match.internalId === '' || match.internalId == null) {
        // Huérfana MÍA (register corrió, el stamp no) -> reanudar activate+setInternalId+verify.
        cic = match.cic;
        recovered = true;
      } else {
        // Ajena (o huérfano histórico envenenado) -> jamás auto-tocar una cuenta bindeada a otro.
        throw new TvEmailOwnedByOtherError(email, match.internalId);
      }
    }

    await this.gigared.activate({ cic, email });
    await this.gigared.setInternalId(cic, internalId);
    const account = await this.gigared.getAccountByInternalId(internalId);
    // B1 (D-pool, part 2) — post-stamp verification: el readback DEBE resolver al CIC recién
    // estampado. Si 404ea o resuelve OTRO cic (el internal_id append-only ya ataba a un dueño
    // histórico), NO reconciliar una fila local sobre una identidad sin confirmar — el retry
    // (probe de este mismo helper) la completa idempotentemente.
    if (account.cic !== cic) throw new TvIdentityStampUnverifiedError(cic, internalId);
    return { cic, account, recovered };
  }

  async execute(
    customerId: string,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      /** #109 — ignorado si se provee; el CIC se asigna automáticamente del pool. */
      cic?: string;
      sendActivationEmail: boolean;
      /**
       * #115 — REQUERIDO para el alta (ya no opcional). La ruta valida 400 si falta.
       * El use case valida ownership del contrato SIEMPRE antes de tocar Gigared.
       * La identidad determinística (email + password) deriva del grContratoId del contrato.
       */
      contractId: string;
      /** #5 BE — actor who triggered this registration (from req.user at the route layer). */
      actorId?: string | null;
      actorName?: string;
    },
  ): Promise<{
    account: GigaredAccount;
    /** B3 (D3) — espejo de `gigared:'ok'` en AddTvService/link: SIEMPRE true si `execute` no tiró
     *  (si el partner-write falla de verdad, `execute` lanza y nunca llega a construir el result). */
    partnerCreated: boolean;
    /** B3 (D3) — campo INDEPENDIENTE de `credentialsPersisted` (Desvíos #5): 'failed' únicamente
     *  cuando el bloque de reconcile local tira; 'synced' si no hay nada que reconciliar
     *  (wantsPersist=false) o si el reconcile corrió sin excepción. */
    localReconciled: 'synced' | 'failed';
    credentialsPersisted: boolean;
    recovered: boolean;
  }> {
    const customer = await this.customerLookup.findById(customerId);
    if (!customer) throw new ClientNotFoundError(customerId);

    // #115 — validate ownership of the target contract ALWAYS before any Gigared write.
    // A foreign/absent contractId → ContractNotFoundError (404), Gigared never touched.
    // Then derive the TV identity (password + email) from grContratoId (not grClienteId).
    const contract = await this.contractLookup!.findById(input.contractId);
    if (!contract || contract.clientId !== customerId) {
      throw new ContractNotFoundError(input.contractId);
    }
    const grContratoId = contract.grContratoId;
    if (grContratoId == null || grContratoId === '') {
      throw new GrContractIdRequiredError(input.contractId);
    }
    const password = deterministicTvPassword(grContratoId);
    // Guard CUA: a grContratoId with chars outside [a-z0-9] yields a non-CUA password.
    // Fail local with the clear 422 instead of an opaque rejection from the partner.
    if (!isValidGigaredPassword(password)) {
      throw new GrContractIdRequiredError(input.contractId);
    }

    // #81 — resolver el seq A USAR para esta alta. SOLO en re-alta (cliente que venía de baja y hay
    // activation repo) se incrementa el seq → identidad fresca. La primera alta queda en seq=0
    // (back-compat: internal_id pelado + el mail que mandó el FE). La señal honesta de "re-alta" es
    // el flag local de baja (#72): si está seteado, el partner ya quemó la identidad anterior.
    //
    // B2 (D2) — seq/internalId/email se resuelven ANTES del probe/pool-pick (se movió desde después
    // del pool-pick): el probe idempotente necesita MI internalId para consultar al partner.
    let seq = 0;
    if (this.activation && this.tvCancellation && (await this.tvCancellation.isCancelled(customerId))) {
      seq = await this.activation.incrementSeq(customerId);
    }
    const internalId = currentTvInternalId(customerId, seq);
    // #81 / #115 / #118 — el email siempre deriva server-side del grContratoId, para ambos casos
    // (seq=0 alta nueva y seq>0 re-alta). El input.email del FE se ignora: antes (pre-#118)
    // la primera alta usaba el email que mandaba el FE, que era derivado del grClienteId, lo que
    // generaba una inconsistencia con la clave (que ya derivaba del grContratoId desde el #115).
    // Ahora la fuente única de la identidad TV es grContratoId: email + password determinísticos.
    const email = deterministicTvEmail(input.lastName, grContratoId, seq);

    // #115 — wantsPersist: el contrato YA está validado arriba (ownership siempre chequeado).
    // La condición de persistencia se reduce a la presencia de los repos locales.
    const wantsPersist = !!this.csRepo && !!this.catalogRepo;

    // B1 (pool anti-poison) + B2 (recovery/probe idempotente) — ver `resolveGigaredAccount`.
    const { cic, account, recovered } = await this.resolveGigaredAccount(internalId, email, password, input);

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
    // B3 (D3) — localReconciled: campo INDEPENDIENTE de credentialsPersisted (Desvíos #5). 'failed'
    // SOLO cuando el bloque de reconcile tira; sin nada que reconciliar (wantsPersist=false) es
    // trivialmente 'synced' (nada falló).
    let localReconciled: 'synced' | 'failed' = 'synced';
    if (wantsPersist && this.csRepo && this.catalogRepo) {
      try {
        const { contractServiceId } = await reconcileTvContractService({
          gigared: this.gigared,
          csRepo: this.csRepo,
          catalogRepo: this.catalogRepo,
          customerId,
          contractId: input.contractId,
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
        localReconciled = 'failed';
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
          cic,
          internalId,
          seq,
          contractId: input.contractId,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[gigared] register: TV activation event record failed (best-effort)', err);
      }
    }

    // B3 (D3) — partnerCreated es SIEMPRE true acá: si el write al partner falló de verdad,
    // `resolveGigaredAccount` ya lanzó y esta línea nunca se alcanza (espejo de `gigared:'ok'`
    // en AddTvService/link — ver Desvíos, ambos también son constantes-si-no-tiró).
    return { account, partnerCreated: true, localReconciled, credentialsPersisted, recovered };
  }
}

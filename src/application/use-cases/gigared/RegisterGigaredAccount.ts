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
import { splitCustomerName } from './splitCustomerName';

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
 * F5(b) — un `internalId` "sin estampar": null, undefined o '' (cuenta LIBRE del pool o huérfana
 * mía a medio registrar). Unifica la guarda en un solo predicado para que el filtro del pool y el
 * discriminador por email traten `undefined` EXACTAMENTE igual que null/'' (el shape real del
 * adapter puede devolver undefined; el `== null` cubre null y undefined a la vez).
 */
function isUnstamped(internalId: string | null | undefined): internalId is '' | null | undefined {
  return internalId == null || internalId === '';
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
 *
 * B8 (D1, hardening OPCIONAL) — el `lastName` de la fórmula de arriba (y el `firstName` que viaja a
 * `gigared.register`) son BE-authoritative: se derivan de `customer.name` vía `splitCustomerName`
 * (split APELLIDO-primero), NUNCA de `input.firstName`/`input.lastName`.
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
    // F2 — el probe SÓLO reancla si la identidad coincide con la MÍA (el internal_id primario).
    // Con alias append-only, getAccountByInternalId(MI-id) puede resolver a un CIC que HOY es de
    // OTRO cliente (post-transfer): confiar en él sin verificar contaminaría la ficha con una cuenta
    // ajena. Mismatch → NO es mía → seguir el flujo normal (pool), jamás reconciliar sobre identidad
    // ajena.
    if (probed && probed.internalId === internalId) {
      return { cic: probed.cic, account: probed, recovered: true };
    }

    // 404 -> B1: pool-pick filtrado (anti-envenenamiento).
    const pool = await this.gigared.listAccounts({ status: 'unregistered' });
    if (pool.length === 0) throw new NoCicAvailableError();
    // F5(a/b) — separar "no usable" (cic vacío/ausente) de "envenenado" (tiene internal_id de un
    // dueño ajeno, residuo append-only de renewCic/transfer). Un entry sin cic NO es veneno: sólo es
    // inutilizable. `isUnstamped` trata undefined igual que null/'' (alinea con el discriminador de
    // abajo y con el shape real del adapter).
    const clean = pool.filter(e => e.cic && isUnstamped(e.internalId));
    if (clean.length === 0) {
      // `poisonedCount` HONESTO: sólo cuenta los realmente envenenados (con internal_id seteado).
      // Si el único problema son entries sin cic (cero envenenados), es indistinto de "no hay CIC
      // disponible" → NoCicAvailableError, no un falso TvPoolPoisonedError.
      const poisonedCount = pool.filter(e => !isUnstamped(e.internalId)).length;
      if (poisonedCount === 0) throw new NoCicAvailableError();
      throw new TvPoolPoisonedError(poisonedCount);
    }
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
      // F5(d) — selección EXPLÍCITA en vez de matches[0] a ciegas: si el partner devuelve varias
      // cuentas con este email (alias append-only), preferimos (1) la que YA tiene MI internal_id
      // (mía estampada) y, si no, (2) una huérfana sin estampar (mía a medio registrar). Recién si
      // no hay ninguna de esas caemos al primer match (dueño ajeno → TvEmailOwnedByOtherError). El
      // orden del array NUNCA decide la rama.
      const match = matches.find(m => m.internalId === internalId)
        ?? matches.find(m => isUnstamped(m.internalId))
        ?? matches[0];
      if (!match) throw err; // sin match -> re-lanzar el GIGARED_REJECTED original tal cual
      if (match.internalId === internalId) {
        // MÍA (ya estampada vía email) -> completar solo local; setInternalId NUNCA se llama.
        return { cic: match.cic, account: match, recovered: true };
      }
      if (isUnstamped(match.internalId)) {
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
    // B1 (D-pool, part 2) — post-stamp verification: el readback DEBE resolver al CIC recién
    // estampado. Si 404ea o resuelve OTRO cic (el internal_id append-only ya ataba a un dueño
    // histórico), NO reconciliar una fila local sobre una identidad sin confirmar — el retry
    // (probe de este mismo helper) la completa idempotentemente.
    //
    // F3 — el readback entra en el try: un 404 acá NO es permanente ("not found" invitaba a
    // reenviar y componía con el doble registro de F1). El stamp pudo persistir con lag de
    // replicación, así que un readback-404 es la MISMA condición "sin confirmar" que un cic
    // mismatch → TvIdentityStampUnverifiedError (503, retriable), no un GigaredNotFoundError (404).
    let account: GigaredAccount;
    try {
      account = await this.gigared.getAccountByInternalId(internalId);
    } catch (err) {
      if (err instanceof GigaredNotFoundError) throw new TvIdentityStampUnverifiedError(cic, internalId);
      throw err;
    }
    if (account.cic !== cic) throw new TvIdentityStampUnverifiedError(cic, internalId);
    return { cic, account, recovered };
  }

  async execute(
    customerId: string,
    input: {
      /**
       * B8 (D1, hardening OPCIONAL) — IGNORADO por el use case. El nombre es BE-authoritative:
       * se deriva de `customer.name` (split APELLIDO-primero, `splitCustomerName`) SIEMPRE, nunca
       * del body. Se mantiene en el shape por tolerancia de deploy (el FE actual todavía lo manda).
       */
      firstName: string;
      /** B8 (D1) — IGNORADO, ver `firstName`. */
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

    // B8 (D1, hardening OPCIONAL) — nombre BE-authoritative: firstName/lastName SIEMPRE derivan
    // del customer resuelto (split APELLIDO-primero), NUNCA de input.firstName/input.lastName.
    // Cierra un vector de corrupción TEÓRICO (la forense probó que el body-name no fue el vector
    // del incidente real — ver design D-pool/D1); input.firstName/lastName quedan en el tipo por
    // tolerancia de deploy pero el código no los lee.
    const { firstName, lastName } = splitCustomerName(customer.name);

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
    //
    // F1 — el candidato del seq se calcula DIFERIDO (getSeq()+1) y NO se persiste acá (antes:
    // incrementSeq, que avanzaba el contador ANTES del intento). Un fallo tras estampar dejaba el
    // seq avanzado → el retry minteaba una identidad NUEVA (nunca estampada) → el probe fallaba →
    // SEGUNDO register real al partner (doble cobro). Ahora el avance se persiste recién tras
    // verificar la identidad (ver ensureSeqAtLeast más abajo), así el retry recomputa el MISMO
    // candidato y converge vía probe.
    let seq = 0;
    const isReAlta = !!(this.activation && this.tvCancellation && (await this.tvCancellation.isCancelled(customerId)));
    if (isReAlta) {
      seq = (await this.activation!.getSeq(customerId)) + 1;
    }
    const internalId = currentTvInternalId(customerId, seq);
    // #81 / #115 / #118 — el email siempre deriva server-side del grContratoId, para ambos casos
    // (seq=0 alta nueva y seq>0 re-alta). El input.email del FE se ignora: antes (pre-#118)
    // la primera alta usaba el email que mandaba el FE, que era derivado del grClienteId, lo que
    // generaba una inconsistencia con la clave (que ya derivaba del grContratoId desde el #115).
    // Ahora la fuente única de la identidad TV es grContratoId: email + password determinísticos.
    // B8 (D1) — el lastName usado es el DERIVADO del customer (split), no input.lastName.
    const email = deterministicTvEmail(lastName, grContratoId, seq);

    // #115 — wantsPersist: el contrato YA está validado arriba (ownership siempre chequeado).
    // La condición de persistencia se reduce a la presencia de los repos locales.
    const wantsPersist = !!this.csRepo && !!this.catalogRepo;

    // B1 (pool anti-poison) + B2 (recovery/probe idempotente) — ver `resolveGigaredAccount`.
    // B8 (D1) — firstName/lastName pasados acá son los DERIVADOS del customer, no los del input.
    const { cic, account, recovered } = await this.resolveGigaredAccount(internalId, email, password, {
      firstName,
      lastName,
      sendActivationEmail: input.sendActivationEmail,
    });

    // #72 — clearCancelled best-effort: el cliente volvió a tener TV (re-registro exitoso).
    // Se intenta siempre que el register + link fue exitoso. Un error aquí NO aborta.
    //
    // F1 — el avance del seq se PERSISTE recién acá, tras register+stamp+verify OK (resolveGigared
    // Account ya retornó → identidad confirmada). El ORDEN es load-bearing: clearCancelled PRIMERO y,
    // sólo si no tiró, ensureSeqAtLeast. Si el clear del flag falla (best-effort), el seq NO se
    // avanza → el flag queda seteado y un retry recomputa el MISMO candidato (getSeq() sin mover) →
    // reancla vía probe en vez de mintear una identidad fresca (que re-registraría al partner: doble
    // cobro). ensureSeqAtLeast es idempotente y jamás retrocede.
    if (this.tvCancellation) {
      try {
        await this.tvCancellation.clearCancelled(customerId);
        if (isReAlta && this.activation) {
          await this.activation.ensureSeqAtLeast(customerId, seq);
        }
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

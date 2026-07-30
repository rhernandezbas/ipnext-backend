import type { GigaredPort, GigaredAccount } from '@domain/ports/GigaredPort';
import type { ContractServiceRepository } from '@domain/ports/ContractServiceRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { ClientTvCancellationRepository } from '@domain/ports/ClientTvCancellationRepository';
import type { ClientTvActivationRepository } from '@domain/ports/ClientTvActivationRepository';
import type { TvActivationEventRepository } from '@domain/ports/TvActivationEventRepository';
import { ClientNotFoundError } from '@domain/errors';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import type { TvCicReuseEligibilityRepository } from '@domain/ports/TvCicReuseEligibilityRepository';
import type { AuditEventRepository } from '@domain/ports/AuditEventRepository';
import {
  GrContractIdRequiredError,
  NoCicAvailableError,
  TvPoolPoisonedError,
  TvIdentityStampUnverifiedError,
  TvEmailOwnedByOtherError,
  TvPoolUnavailableError,
  TvNoUsableCicError,
  GigaredNotFoundError,
  GigaredRejectedError,
} from '@domain/errors/gigared';
import { currentTvInternalId } from '@domain/gigared/tvIdentity';
import { classifyPoolEntry, isUnstamped } from '@domain/gigared/poolCandidate';
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
 * F5(b) — el predicado "sin estampar" (null, undefined o '') se movió al dominio
 * (`@domain/gigared/poolCandidate`), donde lo comparte el clasificador del pool. Acá se sigue
 * usando para el discriminador por email, así que ambos caminos no pueden divergir.
 *
 * gigared-tv-cic-reuse — tope de candidatos que se prueban contra el partner en un mismo alta.
 * WHY: un solo CIC inservible NO puede volver a tumbar el 100% de las altas (2026-07-30), pero
 * tampoco queremos rafaguear el pool entero contra el partner en cada intento.
 */
const MAX_CANDIDATOS = 3;

/**
 * Un candidato del pool listo para probar. `reusedFrom` viaja SÓLO cuando el cic carga la
 * identidad de otro cliente nuestro: es lo que después alimenta el rastro de auditoría
 * (AUD-1). Un candidato limpio no lo lleva, y por eso un alta normal no emite el evento.
 */
type Candidato = { cic: string; reusedFrom?: { internalId: string; clientId: string } };

/**
 * FIX WAVE F8 — contexto que necesita el rastro de auditoría, empujado hasta el punto donde el
 * alias se graba de verdad (`setInternalId`). Se pasa hacia abajo en vez de auditar al volver,
 * porque el camino de vuelta puede cortarse (readback 404) DESPUÉS de que el cambio de dueño
 * ya es permanente en el partner.
 */
interface AuditBase {
  customerId: string;
  contractId: string;
  actorId: string | null;
  actorName: string;
  internalId: string;
}
type AuditCtx = AuditBase & { reusedFrom?: { internalId: string; clientId: string } };

/**
 * Señal INTERNA del reintento: el cic probado no existe / no es nuestro para el partner
 * (403 `cic-ownership-error` o 404 en el `register`).
 *
 * Deliberadamente NO se exporta y NUNCA sale del use case: si escapara, el router no la
 * conocería y caería al 500 genérico. El loop la consume y, agotados los candidatos, la
 * traduce al `TvNoUsableCicError` (422) que sí es contrato de wire.
 */
class CicInservible extends Error {
  constructor(
    public readonly cic: string,
    public readonly causa: unknown,
  ) {
    super(`CIC ${cic} inservible para el partner`);
    this.name = 'CicInservible';
  }
}

/**
 * Rota un grupo de candidatos para que el elegido por `pick` quede PRIMERO, conservando al
 * resto como fallback del reintento. Mantiene el seam `pick` inyectable (tests determinísticos)
 * y el reparto aleatorio real en producción, sin concentrar la carga en un mismo CIC.
 */
function ordenarPorPick<T>(grupo: T[], pick: (n: number) => number): T[] {
  if (grupo.length <= 1) return [...grupo];
  const bruto = pick(grupo.length);
  // Defensivo: un `pick` fuera de rango (o NaN) NO puede tirar un TypeError opaco ni saltear
  // candidatos — cae al índice 0, que siempre existe.
  const i = Number.isInteger(bruto) && bruto >= 0 ? bruto % grupo.length : 0;
  return [grupo[i], ...grupo.slice(0, i), ...grupo.slice(i + 1)];
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
    /**
     * gigared-tv-cic-reuse — decide si un CIC del pool que carga la identidad de OTRO cliente
     * puede reutilizarse. AUSENTE = ningún CIC estampado se reutiliza (degradación SEGURA:
     * el comportamiento es el del filtro B1 original).
     *
     * ⚠️ Esa degradación segura es exactamente la trampa de la W6 del EPIC #38: si el wiring de
     * `app.ts` no lo inyecta, la feature queda MUERTA en producción con el CI en verde, porque
     * los tests inyectan su propio wiring. Por eso hay un composition-root test que falla si
     * `app.ts` construye este use case sin esta dependencia. NO lo borres.
     */
    private readonly reuseEligibility?: TvCicReuseEligibilityRepository,
    /**
     * AUD-1 — rastro estructurado de la reutilización de un CIC. Best-effort: su fallo NUNCA
     * aborta un alta que el partner ya completó.
     *
     * WHY: el sistema reutiliza CICs A PROPÓSITO y sin pedirle confirmación al operador (el
     * operador no tiene información para decidirlo). Lo que hace auditable esa decisión es
     * este rastro — la forense de Centeno fue arqueología pura por no tenerlo (breadcrumb B6).
     */
    private readonly auditRepo?: AuditEventRepository,
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
    auditBase?: AuditBase,
  ): Promise<{
    cic: string;
    account: GigaredAccount;
    recovered: boolean;
    /** AUD-1 — presente SÓLO si el cic elegido cargaba la identidad de otro cliente nuestro. */
    reusedFrom?: { internalId: string; clientId: string };
  }> {
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

    // 404 -> B1 REFINADO (gigared-tv-cic-reuse). Antes esto era un `filter` que exigía el
    // internal_id vacío y NO validaba el FORMATO del cic: por eso un cic corrupto
    // ('00065470 4', con un 0x20 embebido) pasaba como "limpio" y, siendo el ÚNICO candidato,
    // se elegía SIEMPRE (un pick aleatorio sobre un pool de 1 es determinístico) → el 100% de
    // las altas moría con un 404 crudo. Ver `@domain/gigared/poolCandidate`.
    let pool: GigaredAccount[];
    try {
      pool = await this.gigared.listAccounts({ status: 'unregistered' });
    } catch (err) {
      // ERR-1.1 — el ÚNICO error que necesita traducción acá es el NotFound: sin el wrap salía
      // crudo como 404 "Gigared account not found" en pleno ALTA.
      //
      // FIX WAVE F5 — todo lo demás se propaga TAL CUAL. El wrap indiscriminado aplastaba
      // `GigaredAuthError` (API key vencida), `GigaredNotConfiguredError` y `GigaredRejected`
      // en un 503 "reintentá en unos segundos": el operador reintentaría para siempre sobre un
      // problema que no se arregla solo, y se perdía el `detail` RFC 9457 que #47g expone.
      if (!(err instanceof GigaredNotFoundError)) throw err;
      throw new TvPoolUnavailableError(err.message);
    }
    if (pool.length === 0) throw new NoCicAvailableError();

    const limpios: Candidato[] = [];
    const porVerificar: { cic: string; clientId: string; internalId: string; entry: GigaredAccount }[] = [];
    // `descartados` cuenta SÓLO el veneno real (identidad ajena, o nuestra pero no elegible).
    // Un cic MALFORMADO no es veneno — es inutilizable — y contarlo daría un
    // TvPoolPoisonedError falso, exactamente la distinción que F5(a/b) ya hacía.
    // RONDA 4 (F4) — contadores por CAUSA. `descartados` agregaba CUATRO causas distintas
    // (identidad no parseable, cic malformado estampado, cliente no elegible, cuenta ocupada) y
    // el mensaje nombraba UNA sola: "identidad ajena". Un pool de cuentas OCUPADAS de clientes
    // NUESTROS y elegibles reportaba una causa que no había ocurrido.
    let ajenos = 0;
    let ocupadas = 0;
    for (const entry of pool) {
      const c = classifyPoolEntry(entry);
      const cic = entry.cic;
      // Narrowing REAL en vez de un cast: `!cic` ⟺ 'malformado' (classifyPoolEntry devuelve
      // 'malformado' para todo cic ausente o con formato inválido), y un malformado no es ni
      // candidato ni veneno. Así el tipo de las listas es `string` sin mentirle al compilador.
      if (cic && c.kind === 'limpio') {
        limpios.push({ cic });
        continue;
      }
      if (cic && c.kind === 'requiere-verificacion') {
        porVerificar.push({
          cic,
          clientId: c.clientId as string,
          internalId: entry.internalId as string,
          entry,
        });
        continue;
      }
      // No es candidato ('ajeno' o 'malformado'). Cuenta como VENENO sólo si trae identidad
      // ESTAMPADA — semántica F5(a), pinneada por dos tests y EXIGIDA por el spec POOL-1.7: un
      // cic malformado PERO estampado SÍ cuenta; uno sin cic y sin estampar NO (es indistinto
      // de "no hay CIC" → NoCicAvailableError). El comentario anterior decía lo contrario del
      // código y del spec — RONDA 4 lo corrigió.
      if (!isUnstamped(entry.internalId)) ajenos++;
      // RONDA 4 (F5) — EL CIC CORRUPTO SEGUÍA MUDO. Con el pool exacto del incidente del
      // 2026-07-30 el sistema decía "no hay CIC disponible" sin dejar UNA línea con el cic
      // ofensor. OBS-1 cubrió el 403 del partner (el síntoma); la causa raíz —el string
      // corrupto— no dejaba rastro, que es justo lo que costó el diagnóstico la primera vez.
      if (c.kind === 'malformado') {
        // eslint-disable-next-line no-console
        console.warn('[gigared] register: entrada del pool con CIC de formato inválido', JSON.stringify(entry.cic));
      }
    }

    // POOL-1.5 — la 3ra condición de la invariante (elegibilidad del cliente) cruza el mirror
    // local, así que es async y se resuelve ACÁ, ANTES del loop: el conjunto de candidatos
    // queda estable y el orden limpio-primero es determinístico.
    const reutilizables: Candidato[] = [];
    // FIX WAVE 2 — contador SEPARADO de `descartados`: lo que no se pudo verificar NO es
    // veneno. Si el pool queda sin candidatos y hubo aunque sea UNA verificación fallida, la
    // conclusión honesta es "no sé", que es transitoria (503), no "el pool está envenenado".
    let noVerificables = 0;
    for (const p of porVerificar) {
      // FIX WAVE 2 — cortocircuito: si ya hay candidatos suficientes para el reintento acotado,
      // verificar el resto es trabajo puro al pedo. Antes se pagaban N queries a Postgres + N
      // GETs al partner aun cuando el CIC elegido iba a ser uno LIMPIO.
      if (limpios.length + reutilizables.length >= MAX_CANDIDATOS) break;

      // RONDA 4 (F3) — el chequeo PURO va PRIMERO. Es gratis y CONCLUYENTE: si la cuenta está
      // ocupada, no hay nada que preguntarle al mirror. Tenerlo debajo del I/O falible hacía
      // que, con un blip de Postgres, un pool donde NADA es reutilizable saliera como 503
      // reintentable en vez del 422 que corresponde — el mismo enmascaramiento que la ronda 3
      // arregló a nivel agregado, sobreviviendo a nivel POR ENTRADA.
      const estado = this.estadoDeCuentaDelPool(p.entry);
      if (estado === 'ocupada') {
        ocupadas++;
        continue;
      }
      if (estado === 'no-verificable') {
        noVerificables++;
        continue;
      }
      // FIX WAVE F6 — la consulta al mirror NO puede tumbar el alta. Un blip de Postgres en
      // cualquiera de las N verificaciones hacía saltar un 500 genérico AUNQUE hubiera un cic
      // limpio disponible: una regresión de disponibilidad introducida por este mismo change.
      // Un fallo se trata como "no elegible" — el lado seguro — y el alta sigue con los limpios.
      let elegibleLocal = false;
      try {
        elegibleLocal =
          !!this.reuseEligibility && (await this.reuseEligibility.isEligibleForCicReuse(p.clientId));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[gigared] register: eligibility check failed', err);
        // FIX WAVE 2 — la consulta al mirror FALLÓ: es infraestructura, no veneno.
        noVerificables++;
        continue;
      }
      if (!elegibleLocal) {
        ajenos++;
        continue;
      }

      // FIX WAVE F4 — el mirror local NO alcanza para decidir esto. La invariante de 3
      // condiciones puede dar `true` sobre un cliente CON una cuenta VIVA en el partner:
      //   (a) el propio alta deja la fila de TV en `inactive` ("todavía no hay packs"), y
      //   (b) `clearCancelled` es best-effort y puede dejar el flag de baja seteado;
      //   (c) post-transferencia, el cliente ORIGEN queda cancelado + fila inactiva mientras
      //       el CIC es del DESTINO (el internal_id es append-only y aliasea).
      // En los tres casos reutilizar ese cic le ROBA la TV a alguien — el incidente Centeno
      // atravesando el filtro que se puso para evitarlo.
      //
      // La única fuente de verdad sobre si la cuenta está libre es EL PARTNER: una cuenta
      // realmente sin registrar viene con email/nombre/fecha en null (verificado en las 10 del
      // pool real del 2026-07-30). Si no se puede verificar, NO se reutiliza.
      reutilizables.push({
        cic: p.cic,
        reusedFrom: { internalId: p.internalId, clientId: p.clientId },
      });
    }

    // POOL-1.6 — LIMPIO PRIMERO. Reutilizar es correcto, pero deja un alias PERMANENTE en el
    // partner (el internal_id viejo no se puede borrar). Mientras haya un cic limpio se usa
    // ese; la reutilización es el FALLBACK. Es lo que acota la acumulación de alias.
    const pickFn = this.pick ?? ((n: number) => Math.floor(Math.random() * n));
    const candidatos = [
      ...ordenarPorPick(limpios, pickFn),
      ...ordenarPorPick(reutilizables, pickFn),
    ];

    if (candidatos.length === 0) {
      // FIX WAVE 2 — el orden importa. Si algo no se pudo VERIFICAR, no sabemos si el pool
      // está envenenado: la conclusión honesta es transitoria (503, reintentable), no un 422
      // que le dice al operador "contactá al administrador" cuando lo que falló fue la DB o el
      // partner. `poisonedCount` queda reservado a veneno REAL.
      // RONDA 3 — antes `noVerificables > 0` ganaba INCONDICIONALMENTE, sin mirar magnitudes:
      // UN solo fallo de verificación enmascaraba N venenos. Probado por el revisor con un pool
      // de 20 (19 identidades ajenas de terceros VIVOS + 1 no verificable) → salía 503
      // "reintentá en unos segundos" y los 19 envenenados no aparecían en ninguna parte de la
      // respuesta. El operador reintentando para siempre sobre un pool que no se arregla solo.
      //
      // Ahora la duda gana sólo si DOMINA (o empata): con 19 venenos y 1 duda, el diagnóstico
      // honesto es "pool envenenado". Y los DOS contadores viajan en el mensaje siempre, así
      // que ningún número queda escondido.
      // RONDA 4 (F4) — el mensaje nombra la CAUSA REAL. `descartados` = identidad ajena/no
      // elegible + cuenta ocupada; son cosas distintas y el operador necesita saber cuál fue.
      const descartados = ajenos + ocupadas;
      if (descartados === 0 && noVerificables === 0) throw new NoCicAvailableError();

      // RONDA 3 — la duda gana sólo si DOMINA (o empata): UN fallo de verificación no puede
      // enmascarar N venenos. Y los contadores viajan SIEMPRE en el mensaje.
      if (noVerificables >= descartados) {
        const causas = [
          ajenos > 0 ? `${ajenos} por identidad ajena` : null,
          ocupadas > 0 ? `${ocupadas} con la cuenta ocupada` : null,
        ].filter(Boolean).join(' y ');
        throw new TvPoolUnavailableError(
          `no se pudieron verificar ${noVerificables} CIC(s) del pool` +
            (causas ? ` (+${descartados} descartado(s): ${causas})` : ''),
        );
      }
      throw new TvPoolPoisonedError(descartados);
    }

    // POOL-2 — reintento ACOTADO. Un cic inservible descarta ESE candidato y sigue con el
    // siguiente, en vez de tumbar el alta entera. Sólo un not-found en el `register` cuenta
    // como "inservible" (ver `CicInservible`): ahí el partner probó que la cuenta no es nuestra
    // ⇒ no se creó nada ⇒ reintentar es seguro.
    const aProbar = candidatos.slice(0, MAX_CANDIDATOS);
    for (const candidato of aProbar) {
      try {
        const r = await this.intentarConCandidato(
          candidato.cic, internalId, email, password, input,
          auditBase ? { ...auditBase, reusedFrom: candidato.reusedFrom } : undefined,
        );
        // El discriminador por email puede REDIRIGIR a otra cuenta (`match.cic`). Si el cic
        // final no es el del candidato, `reusedFrom` ya no describe nada real → se descarta,
        // porque una auditoría que miente es peor que no tenerla.
        // RONDA 3 — se exige `estampado` ADEMÁS del cic: sin estampado no hubo cambio de
        // dueño, así que afirmar una reutilización en el Historial de TV sería mentir.
        const reusedFrom =
          r.estampado && r.cic === candidato.cic ? candidato.reusedFrom : undefined;
        return { ...r, reusedFrom };
      } catch (err) {
        if (err instanceof CicInservible) continue;
        throw err;
      }
    }
    throw new TvNoUsableCicError(aProbar.length);
  }

  /**
   * FIX WAVE F4 — ¿la cuenta de este CIC está REALMENTE libre del lado del partner?
   *
   * Se consulta por CIC (no por internal_id: el mapeo es append-only y aliasea, así que
   * preguntar por identidad devolvería la cuenta aunque el dueño vigente sea otro).
   *
   * Una cuenta sin registrar del pool viene con `email`, `firstName`, `lastName` y
   * `registrationDate` en null — verificado contra las 10 cuentas reales del pool el
   * 2026-07-30. Basta con que UNO de esos venga seteado para concluir que hay alguien usándola.
   *
   * Ante cualquier error de la consulta se devuelve `false`: no poder verificar NO es permiso.
   */
  /**
   * FIX WAVE F8 (AUD-1) — rastro estructurado del cambio de dueño de un CIC. Best-effort:
   * su fallo NUNCA aborta un alta cuyo write al partner ya ocurrió (AUD-1.3). El `console.warn`
   * es parte del contrato: un rastro que falla EN SILENCIO es el mismo pecado que OBS-1 corrige.
   */
  private async auditarReuso(cic: string, ctx: AuditCtx): Promise<void> {
    if (!this.auditRepo || !ctx.reusedFrom) return;
    try {
      await this.auditRepo.record({
        actorId: ctx.actorId,
        actorLogin: ctx.actorName,
        method: 'POST',
        path: `/api/gigared/customers/${ctx.customerId}/register`,
        action: 'tv.cic_reused',
        entityType: 'GigaredAccount',
        entityId: cic,
        beforeJson: { internalId: ctx.reusedFrom.internalId, clientId: ctx.reusedFrom.clientId },
        afterJson: { internalId: ctx.internalId, clientId: ctx.customerId, contractId: ctx.contractId },
        statusCode: 200,
        errorMessage: null,
        ip: null,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[gigared] register: audit of reused CIC failed (best-effort)', err);
    }
  }

  /**
   * ¿La cuenta de esta entrada del pool está REALMENTE libre, según el PARTNER?
   *
   * RONDA 3 — antes esto hacía un `getAccountByCic(cic)` EXTRA por cada candidato. Se eliminó
   * por dos razones, y la segunda es la grave:
   *
   *  1. Era REDUNDANTE. `listAccounts` y `getAccountByCic` comparten el MISMO `mapAccount`
   *     (`GigaredClient.ts:352` y `:373`), así que los cuatro campos YA vienen en cada entrada
   *     del listado. Se pagaban N llamadas al partner por alta para releer lo mismo.
   *  2. Colgaba la premisa de un ENDPOINT QUE NADIE VERIFICÓ. La muestra que justifica este
   *     predicado (las 10 cuentas del 2026-07-30, todas con los 4 campos en null) salió de
   *     `GET /accounts?status=unregistered`. `getAccountByCic` es `GET /accounts/{cic}`, otro
   *     endpoint: si para una cuenta del pool respondiera 404, o mandara las claves ausentes,
   *     la feature quedaba INERTE (503 o 422 en el 100% de las altas) **con el CI verde**,
   *     porque todos los fakes devuelven exactamente lo que el código espera. Es el patrón
   *     "feature sin perilla" otra vez.
   *
   * Ahora es PURA y se apoya en el mismo dato que ya usó `classifyPoolEntry`: si desconfiáramos
   * del listado, el clasificador entero estaría apoyado en datos que no creemos.
   *
   * FALLA CERRADO: un campo AUSENTE (`undefined`) es DESCONOCIDO, no vacío. Se exige `null` o
   * `''` explícito. Un `undefined` no se trata como veneno (sería un 422 terminal mintiendo
   * sobre la causa) sino como no-verificable → transitorio, y SE LOGUEA.
   */
  private estadoDeCuentaDelPool(entry: GigaredAccount): 'libre' | 'ocupada' | 'no-verificable' {
    const campos = {
      email: entry.email,
      firstName: entry.firstName,
      lastName: entry.lastName,
      registrationDate: entry.registrationDate,
    };

    const ausentes = Object.entries(campos).filter(([, v]) => v === undefined).map(([k]) => k);
    if (ausentes.length > 0) {
      // El partner cambió el shape del envelope. NO se puede concluir nada sobre la cuenta.
      // eslint-disable-next-line no-console
      console.warn(
        '[gigared] register: la cuenta del pool no trae los campos para verificarla',
        entry.cic,
        ausentes,
      );
      return 'no-verificable';
    }

    const vacio = (v: string | null): boolean => v === null || v === '';

    // RONDA 4 (F9) — señal ORTOGONAL, gratis y en otra rama del payload. Los 4 campos de `crm`
    // pueden fallar JUNTOS ante un cambio de shape; `ott.registeredDevices` no depende de
    // ninguno de ellos, y una cuenta con dispositivos registrados NO está libre por definición.
    // Las 10 cuentas del pool real del 2026-07-30 traían todas `qty_registered_devices: 0`.
    //
    // ⚠️ Y cubre un hueco REAL de la falla-cerrada: `normalizeRegistrationDate` colapsa a `null`
    // tanto la clave AUSENTE como cualquier formato que no reconozca, así que para ESE campo
    // "no sé" y "está vacío" son indistinguibles y la basura cae al lado permisivo. Los otros
    // tres sí distinguen `undefined`, y ahora esta cuarta señal es independiente de los cuatro.
    const sinDispositivos = (entry.ott?.registeredDevices ?? 0) === 0;

    const libre =
      vacio(campos.email) &&
      vacio(campos.firstName) &&
      vacio(campos.lastName) &&
      vacio(campos.registrationDate) &&
      sinDispositivos;

    if (!libre) {
      // eslint-disable-next-line no-console
      console.warn('[gigared] register: la cuenta del pool está OCUPADA, no se reutiliza', entry.cic);
    }
    return libre ? 'libre' : 'ocupada';
  }

  /**
   * gigared-tv-cic-reuse — UN intento completo sobre un candidato del pool:
   * register → activate → setInternalId → verificación post-stamp.
   *
   * Extraído de `resolveGigaredAccount` para que el reintento no reindente el cuerpo y, sobre
   * todo, para que el ÚNICO punto que produce `CicInservible` sea explícito y auditable.
   */
  private async intentarConCandidato(
    cicInicial: string,
    internalId: string,
    email: string,
    password: string,
    input: { firstName: string; lastName: string; sendActivationEmail: boolean },
    auditCtx?: AuditCtx,
  ): Promise<{
    cic: string;
    account: GigaredAccount;
    recovered: boolean;
    /**
     * RONDA 3 — ¿corrió `setInternalId` EN ESTE INTENTO? Es la única señal honesta de que
     * hubo un cambio de dueño. Antes había DOS guardas para el mismo hecho (`cic ===
     * cicInicial` para la auditoría y `r.cic === candidato.cic` para el `reason`) y podían
     * DISCREPAR: en la rama "MÍA ya estampada" del discriminador por email no se estampa
     * nada, pero si el cic coincidía el `reason` afirmaba una reutilización que la auditoría
     * no respaldaba. Los dos rastros del mismo alta se contradecían.
     */
    estampado: boolean;
  }> {
    let cic = cicInicial;
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
      // POOL-2.1 / POOL-2.3 — ÚNICO punto donde nace `CicInservible`. Un not-found en el
      // `register` prueba que el partner no reconoce ese cic como nuestro ⇒ NADA se creó ⇒ el
      // caller puede probar otro candidato sin riesgo de doble registro (doble cobro, F1).
      // Todo otro error se propaga tal cual: un fallo en `activate`/`setInternalId` ocurre
      // sobre una cuenta que SÍ existe, y reintentar con otro cic dejaría una huérfana a
      // medio registrar.
      // FIX WAVE F3 — el reintento exige `cicNotOwned`: SÓLO el 403 `cic-ownership-error`
      // prueba que el partner rechazó antes de crear nada. Un not-found sin esa marca (p.ej.
      // el 424 `external-service-error`: el partner aceptó y su downstream falló) deja el
      // estado DESCONOCIDO ⇒ probar otro cic podría crear una segunda cuenta real. Ahí la
      // condición honesta es "identidad sin confirmar": 503 retriable, y el probe idempotente
      // converge en el reintento SIN re-registrar.
      if (err instanceof GigaredNotFoundError) {
        if (err.cicNotOwned) throw new CicInservible(cic, err);
        throw new TvIdentityStampUnverifiedError(cic, internalId);
      }
      if (!(err instanceof GigaredRejectedError)) throw err;
      // D2 — discriminador por email: register rechazó (duplicado). Buscamos quién es dueño hoy
      // del email determinístico para decidir si podemos reanudar, completar local, o rechazar.
      // FIX WAVE F1 (ERR-1.2) — esta consulta NO estaba protegida: su not-found salía crudo y
      // el operador veía un 404 "Gigared account not found" en pleno alta. Un not-found acá
      // significa "el partner no encontró ninguna cuenta con ese email" ⇒ CERO matches, que es
      // la misma semántica que la lista vacía. Se degrada a [] y el flujo sigue su curso
      // normal (sin match → se re-lanza el GIGARED_REJECTED original, que es el error honesto).
      let matches: GigaredAccount[];
      try {
        matches = await this.gigared.listAccounts({ email });
      } catch (listErr) {
        if (!(listErr instanceof GigaredNotFoundError)) throw listErr;
        matches = [];
      }
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
        // No se llama a `setInternalId`: no hubo cambio de dueño en este intento.
        return { cic: match.cic, account: match, recovered: true, estampado: false };
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

    // FIX WAVE F1 (ERR-1.2) — activate y setInternalId corren DESPUÉS de que el register salió
    // bien: la cuenta YA EXISTE en el partner. Un not-found acá (típicamente el 403
    // `cic-ownership-error` que `mapError` traduce a NotFound) NO puede reintentarse con otro
    // cic —dejaría una cuenta huérfana a medio registrar— ni salir crudo como 404 "Gigared
    // account not found", que es EXACTAMENTE el mensaje del incidente del 2026-07-30.
    //
    // La condición real es "la identidad quedó sin confirmar", que ya tiene su error: 503
    // retriable, y el probe idempotente de `resolveGigaredAccount` completa el reintento.
    try {
      await this.gigared.activate({ cic, email });
      await this.gigared.setInternalId(cic, internalId);
    } catch (err) {
      if (err instanceof GigaredNotFoundError) {
        throw new TvIdentityStampUnverifiedError(cic, internalId);
      }
      throw err;
    }

    // FIX WAVE F8 (AUD-1.1) — el rastro se emite ACÁ, no en `execute`: éste es el instante en
    // que el alias queda GRABADO en el partner de forma PERMANENTE (append-only, sin unlink).
    // Todo lo que viene después —readback, reconcile local— puede fallar y reintentarse; el
    // cambio de dueño del CIC, no. Emitirlo más tarde lo perdía en ese hueco exacto.
    //
    // FIX WAVE 2 (F8-bis) — `cic` es una variable MUTADA: el discriminador por email pudo
    // haberla movido a `match.cic`, una cuenta DISTINTA de la que clasificamos. Si eso pasó,
    // `auditCtx.reusedFrom` describe al dueño previo del candidato ORIGINAL y no tiene nada
    // que ver con la cuenta sobre la que terminamos escribiendo: auditarlo inventaría un
    // cambio de dueño que NUNCA ocurrió, sobre un cliente que ni participó. El guard existía
    // (`r.cic === candidato.cic`) pero el fix F8 lo dejó río ABAJO del punto de emisión.
    if (auditCtx?.reusedFrom && cic === cicInicial) await this.auditarReuso(cic, auditCtx);
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
    return { cic, account, recovered, estampado: true };
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
    const { cic, account, recovered, reusedFrom } = await this.resolveGigaredAccount(
      internalId,
      email,
      password,
      { firstName, lastName, sendActivationEmail: input.sendActivationEmail },
      // FIX WAVE F8 — el contexto del rastro viaja HACIA ABAJO para poder auditar en el
      // instante en que el alias se graba, no al volver (el camino de vuelta puede cortarse).
      {
        customerId,
        contractId: input.contractId,
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? '',
        internalId,
      },
    );

    // FIX WAVE F8 — el rastro de la reutilización YA se emitió dentro de `intentarConCandidato`,
    // en el instante exacto en que `setInternalId` grabó el alias en el partner. Emitirlo acá
    // lo perdía justo cuando más importa: si el readback post-stamp 404ea (lag de replicación),
    // el alias YA quedó grabado —es append-only, no hay unlink— pero `execute` nunca llegaba a
    // esta línea, y el reintento reancla vía probe SIN `reusedFrom`. El evento no se emitía
    // nunca. `reusedFrom` sigue viajando hasta acá sólo para el `reason` del evento de TV.

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
          // AUD-1.2 — visible para el operador en el Historial de TV. Misma convención que el
          // breadcrumb `renewCic:{newCic}` que ya escribe CancelTvJobRunner en este campo.
          reason: reusedFrom ? `reusedFrom:${reusedFrom.internalId}` : null,
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

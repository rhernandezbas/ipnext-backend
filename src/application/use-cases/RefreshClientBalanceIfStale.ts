import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { ClientMirrorRepository } from '@domain/ports/ClientMirrorRepository';

/** Default TTL (minutes) before a balance is considered stale. Shared constant so
 * every caller of `isBalanceOlderThanTtl` (this collaborator's own gate AND
 * GetInboxClientContext's mirror-only RICH-4 default path) uses the EXACT SAME
 * default and never drifts apart. */
export const DEFAULT_BALANCE_STALE_TTL_MINUTES = 60;

/**
 * fix wave F7 — TTL del carril LENTO: 26 horas.
 *
 * = la cadencia del carril (1×/día, de madrugada) + 2h de margen para que un
 * corrimiento de la ventana no marque stale a toda la población de golpe.
 */
export const SLOW_LANE_BALANCE_TTL_MINUTES = 26 * 60;

/**
 * Statuses cuyo balance se refresca en el carril LENTO.
 *
 * ⚠️ Espejo de `SLOW_LANE.estados` (`RefreshDebtorBalances`) traducido por
 * `mapStatus`. No se importan de allá a propósito: `mapStatus` vive en el
 * adapter Prisma y esto es capa de aplicación. La correspondencia NO queda
 * librada al comentario — `balanceStaleness.crossSite.test.ts` la pinea
 * recorriendo `SLOW_LANE.estados`/`FAST_LANE.estados` de verdad, que es el
 * único lugar donde se pueden mirar las tres capas a la vez.
 */
const SLOW_LANE_STATUSES: ReadonlySet<string> = new Set(['baja']);

/**
 * fix wave F7 — **el TTL sale del CARRIL, no es único.**
 *
 * Había un solo TTL (60min) para una base que se refresca en dos cadencias: el
 * carril rápido cada hora, y el lento —las 9.082 bajas, el 62% de los
 * clientes— una vez por día. Con 60min, toda baja quedaba `balanceStale:true`
 * de forma PERMANENTE: un flag que grita siempre no informa nada, y encima
 * empujaba refrescos on-demand contra GR que jamás iban a "arreglar" la
 * frescura, porque el dato ya era todo lo fresco que su carril permite.
 *
 * Un status desconocido cae al carril RÁPIDO a propósito: equivocarse hacia
 * "refrescar de más" cuesta una llamada a GR; hacia "refrescar de menos" cuesta
 * un saldo viejo servido como fresco, que es el modo de falla que todo este
 * change existe para evitar. La basura va al valor SEGURO, no al permisivo.
 *
 * ⚠️ **fix wave 3 (FW3) — el carril rápido NO lleva margen de batch, y la razón
 * es esa misma política.** La fix wave 2 le había sumado un
 * `FAST_LANE_BATCH_MARGIN_MINUTES` de 60 (efectivo 2h) con este argumento: el
 * sello `lastBalanceAt` se pone cuando el batch TOCA a cada cliente y el pase
 * tarda ~43min, así que el flag queda prendido buena parte de cada hora sobre el
 * dato más fresco que el batch puede producir — "y los refrescos on-demand que
 * eso dispara no pueden mejorar nada".
 *
 * Esa última premisa es FALSA. Este TTL no es sólo el flag de display: es
 * TAMBIÉN el gate del refresh on-demand (ver `isStale` abajo), y ese refresh no
 * re-lee el batch — le pega a `gr.fetchClientBalance` EN VIVO. Le pregunta a la
 * fuente. Escenario medido con el margen puesto: cliente activo con $45.000
 * sellados hace 90min que pagó hace 30 ⇒ el bot le contesta `tieneDeuda:true,
 * saldo:45000` con CERO llamadas a GR. Le reclamamos plata al que ya pagó, que
 * es exactamente el modo de falla que este change existe para evitar.
 *
 * El costo que se acepta a cambio: por el skew del sello del batch, el flag
 * puede quedar prendido hasta ~43min de más, y cada uno de esos clientes dispara
 * un refresh on-demand. Es el lado SEGURO del error —una llamada de más, que el
 * single-flight (F2) colapsa por cliente y el `maxRetries: 1` acota— y es lo que
 * dicen los dos párrafos de arriba. El carril LENTO sí lleva margen, pero por
 * otro motivo: sin él TODA baja queda stale permanente (26h > cadencia diaria),
 * o sea el flag deja de informar; acá el flag informa de más, no de menos.
 */
export function balanceTtlMinutesForStatus(
  status: string | null | undefined,
  fastLaneTtlMinutes: number,
): number {
  return status != null && SLOW_LANE_STATUSES.has(status)
    ? SLOW_LANE_BALANCE_TTL_MINUTES
    : fastLaneTtlMinutes;
}

/**
 * messaging-inbox-v2 (F1.5, B2) — pure staleness check, extracted out of the
 * `isStale` private method so it can be reused verbatim by GetInboxClientContext's
 * default (no-refresh) path (RICH-4): that path MUST compute `balance.stale` with
 * the SAME TTL rule as this collaborator WITHOUT invoking it (no GR call). A
 * hand-rolled duplicate of this rule in the use case would risk drifting from
 * this one if the TTL default or the comparison ever changes here.
 *
 * fix-be #6 — named `isBalanceOlderThanTtl` (not `isBalanceStale`): that name
 * collided with the private, semantically DIFFERENT `isBalanceStale` in
 * `PrismaCustomerRepository.ts` (status-aware, debtor-only — `(status, lastBalanceAt,
 * ttlMinutes)`). Same name, different signature/rule — confusing even though they
 * never actually clash at compile time (different modules).
 */
export function isBalanceOlderThanTtl(
  lastBalanceAt: string | null | undefined,
  ttlMinutes: number,
  now: () => Date,
): boolean {
  if (!lastBalanceAt) return true; // never fetched
  const ageMs = now().getTime() - new Date(lastBalanceAt).getTime();
  return ageMs > ttlMinutes * 60 * 1000;
}

export interface RefreshClientBalanceIfStaleOptions {
  now?: () => Date;
  /** TTL in minutes before a balance is considered stale. Default: 60. */
  ttlMinutes?: number;
  /** Max ms to wait for GR before falling back to stored value. Default: 4000. */
  timeoutMs?: number;
}

export interface RefreshInput {
  /** GR client id — null if the client has no GR link (no call will be made). */
  grClienteId: string | null | undefined;
  /** ISO timestamp of the last balance fetch, or null if never fetched. */
  lastBalanceAt: string | null | undefined;
  /**
   * fix wave F7 — status del cliente, para elegir el TTL del CARRIL correcto
   * (ver `balanceTtlMinutesForStatus`). Opcional y aditivo: sin él se usa el
   * TTL rápido, que es el lado seguro (refresca de más, nunca de menos).
   *
   * Que esté acá y no sólo en el mapper importa: sin esto, la ficha de una
   * `baja` se muestra "fresca" (TTL 26h) pero igual dispara una llamada a GR
   * cada 60 minutos — el gate visible y el gate real discrepando en silencio.
   */
  status?: string | null;
}

/**
 * On-demand stale check collaborator for GetClientDetail.
 *
 * Called INSIDE the request handler for a debtor. If the balance is stale
 * (null or older than TTL), it attempts a live fetchClientBalance with a
 * short timeout. On success, persists and returns true. On GR error or timeout,
 * swallows the error and returns false (the caller falls back to the stored value
 * with balanceStale:true). Never throws.
 *
 * DIP-clean: depends only on ports, never on Prisma or the adapter.
 */
export class RefreshClientBalanceIfStale {
  private readonly now: () => Date;
  private readonly ttlMinutes: number;
  private readonly timeoutMs: number;

  /**
   * fix wave F2 — **single-flight por `grClienteId`.** Vuelos (fetch GR +
   * escritura) en curso, indexados por cliente.
   *
   * La carrera: la ficha y el bot comparten ESTA instancia (pineado por
   * `assistant-composition.test.ts`) y pueden entrar a la vez sobre el mismo
   * cliente. Sin dedup son dos llamadas a GR y dos escrituras — y como el
   * `lastBalanceAt` se sella con el reloj de CADA vuelo, el que termina último
   * gana: un snapshot VIEJO puede pisar al nuevo y quedar marcado como fresco.
   * Un saldo desactualizado con timbre de fresco es el peor de los dos mundos
   * (nadie lo ve stale, así que nadie lo refresca).
   *
   * Deploy single-process ⇒ un mapa en memoria alcanza. Si algún día hay varias
   * réplicas, esto degrada a "una llamada por réplica" — sigue siendo mejor que
   * hoy, pero ahí haría falta un lock distribuido (molde: el lock `gr-sync`).
   */
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly gr: GestionRealPort,
    private readonly mirror: ClientMirrorRepository,
    opts: RefreshClientBalanceIfStaleOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.ttlMinutes = opts.ttlMinutes ?? DEFAULT_BALANCE_STALE_TTL_MINUTES;
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  /**
   * Returns true when a fresh balance was fetched and stored; false otherwise
   * (not stale, no grClienteId, or GR failed).
   */
  async execute(input: RefreshInput): Promise<boolean> {
    const { grClienteId, lastBalanceAt, status } = input;
    if (!grClienteId) return false;
    // El gate de staleness va ANTES del dedup a propósito: es local, barato y
    // per-caller. Lo que se dedupe es el VUELO, que es lo caro (una llamada a GR)
    // y lo único que puede invertir snapshots.
    if (!this.isStale(lastBalanceAt, status)) return false;

    const inFlight = this.inFlight.get(grClienteId);
    if (inFlight) return inFlight; // el segundo caller ESPERA al primero, no abre otro vuelo

    const flight = this.fetchAndStore(grClienteId).finally(() => {
      // El slot se libera SIEMPRE (éxito, fallo o timeout): un slot colgado
      // dejaría al cliente sin refresco para siempre.
      this.inFlight.delete(grClienteId);
    });
    this.inFlight.set(grClienteId, flight);
    return flight;
  }

  /** Un vuelo: fetch a GR + persistencia atómica. NUNCA lanza (contrato de `execute`). */
  private async fetchAndStore(grClienteId: string): Promise<boolean> {
    try {
      const at = this.now();
      const balance = await this.withTimeout(this.gr.fetchClientBalance(grClienteId), this.timeoutMs);
      // Sync the client's GR invoices from the SAME payload (zero extra GR calls).
      // Guard (review #1): debt reported (amount > 0) but no itemized invoices ⇒ the list
      // is non-authoritative (schema drift / partial payload); a blind replace-all would
      // wipe the mirror. Sync only when authoritative: non-empty, or genuine zero-debt.
      const invoices = balance.invoices.length > 0 || balance.amount <= 0 ? balance.invoices : null;
      // fix wave F3 — saldo y facturas en UNA transacción. Antes eran dos
      // escrituras independientes: si la segunda fallaba, la primera ya estaba
      // commiteada y este método devolvía `false` — el caller creía que no había
      // pasado nada mientras la base quedaba en split-brain (saldo nuevo,
      // facturas viejas), sellado con un `lastBalanceAt` fresco que impedía que
      // alguien lo volviera a pedir.
      await this.mirror.updateBalanceAndInvoices({
        grClienteId,
        amount: balance.amount,
        currency: balance.currency,
        invoices,
        at,
      });
      return true;
    } catch {
      // Swallow — caller will serve stored value with balanceStale:true
      return false;
    }
  }

  private isStale(lastBalanceAt: string | null | undefined, status?: string | null): boolean {
    // `isBalanceOlderThanTtl` NO cambia (misma regla de edad para todos): lo que
    // cambia es QUÉ ttl se le pasa, según el carril del status (F7).
    return isBalanceOlderThanTtl(lastBalanceAt, balanceTtlMinutesForStatus(status, this.ttlMinutes), this.now);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`GR timeout after ${ms}ms`)), ms);
      promise.then(
        v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); },
      );
    });
  }
}

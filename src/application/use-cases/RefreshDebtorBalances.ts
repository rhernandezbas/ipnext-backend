import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { ClientMirrorRepository } from '@domain/ports/ClientMirrorRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';

/**
 * Un CARRIL de refresco: qué estados GR enumera y bajo qué `entity` de
 * `SyncState` reporta. Se pasa SIEMPRE explícito desde el composition root —
 * deliberadamente NO hay default (ver `gr-balance-refresh-lanes`, Decisión 1):
 * con dos carriles no existe un default correcto, y el bug que este change
 * arregla ERA precisamente una lista de estados por defecto que nadie volvió a
 * mirar. Sin default, olvidarse de configurar el carril no compila.
 */
export interface BalanceLane {
  /** Clave de `SyncState` — una por carril, para que no se pisen la observabilidad. */
  readonly entity: string;
  /** Prefijo de log, para poder distinguir los dos carriles en prod. */
  readonly logPrefix: string;
  /** Estados GR a enumerar. */
  readonly estados: readonly string[];
}

/**
 * Carril RÁPIDO (cada hora): Activo (1), Deudor (2), Inactivo (3), Incobrable (4).
 *
 * ⚠️ El estado 1 (Activo) estuvo EXCLUIDO hasta el 2026-08-04, con este comentario:
 *   "NUNCA se agrega el estado 1 (Activo): verificado en vivo que siempre devuelve
 *    cero facturas, así que enumerarlo solo desperdiciaría llamadas GR."
 * **La premisa era FALSA.** Medido en vivo contra GR: de una muestra aleatoria de 40
 * clientes estado=1, **33 (82,5%) tenían facturas con saldo** — incluido un cliente
 * Activo con $127.561,28 de deuda. La verificación original se había hecho contra
 * `clientes_consulta` (el endpoint de ENUMERAR, que NO devuelve ningún campo de
 * deuda) y no contra `cliente`, que es el que este use case realmente llama para el
 * balance. Consecuencia: **5.325 clientes activos —los únicos que usan la app de
 * clientes— jamás veían refrescadas sus facturas**, y una factura ya pagada les
 * quedaba `pendiente` para siempre.
 *
 * La `entity` se CONSERVA como `gr-debtor-balances` (aunque el nombre ya quede
 * impreciso) porque `GetFinanceSyncStatus` la lee para el dashboard de Finanzas:
 * renombrarla dejaría esa tarjeta huérfana en silencio.
 */
export const FAST_LANE: BalanceLane = {
  entity: 'gr-debtor-balances',
  logPrefix: 'gr-balance',
  estados: ['1', '2', '3', '4'],
};

/**
 * Carril LENTO (1 vez por día, de madrugada): Baja (6).
 *
 * Las bajas son 9.082 de los 14.664 clientes — el 62% del presupuesto de llamadas
 * a GR — y su deuda está congelada: no cambia de una hora a la otra. Refrescarlas
 * cada hora era gastar el 97% del presupuesto anterior (9.082/9.339) en gente que
 * ya se fue, mientras los activos no se refrescaban nunca.
 */
export const SLOW_LANE: BalanceLane = {
  entity: 'gr-balances-bajas',
  logPrefix: 'gr-balance-bajas',
  estados: ['6'],
};

const DEFAULT_PAGE_SIZE = 100;

export interface RefreshDebtorBalancesResult {
  refreshed: number;
  skipped: number;
  errors: number;
}

export interface RefreshDebtorBalancesOptions {
  now?: () => Date;
  pageSize?: number;
}

/**
 * Batch use case: fetch the outstanding balance (and the itemized invoices that
 * come in the SAME payload) for every client of the given CARRIL, and persist it
 * via ClientMirrorRepository.
 *
 * Corre en dos carriles — ver `FAST_LANE` / `SLOW_LANE`:
 *   - RÁPIDO (cada hora): estados 1/2/3/4 — 5.582 clientes, ~43 min medidos.
 *   - LENTO (1×/día, madrugada AR): estado 6 (Bajas) — 9.082 clientes, ~70 min.
 *
 * Itera los buckets de estado secuencialmente; deduplica los ids con un Set
 * antes de pedir balances. Un fallo de un cliente loguea y sigue — el batch
 * nunca aborta a mitad de camino. Un fallo mayorista (GR caído al enumerar) se
 * captura, se registra en SyncState (mismo patrón que SyncGestionRealClients) y
 * se devuelve como error (nunca se re-lanza).
 *
 * ⚠️  Volumen: a 0,459 s por llamada (medido 2026-08-04), el carril rápido tarda
 * ~43 min de su ventana de 60. Si la base de clientes crece ~40%, vuelve a
 * pasarse de la ventana y hay que revisar la partición de carriles. Los dos
 * carriles comparten un guard de exclusión en el scheduler para no duplicar la
 * carga instantánea sobre GR (riesgo de 429s).
 */
export class RefreshDebtorBalances {
  private readonly now: () => Date;
  private readonly pageSize: number;

  constructor(
    private readonly gr: GestionRealPort,
    private readonly mirror: ClientMirrorRepository,
    private readonly state: SyncStateRepository,
    /** Carril a correr. REQUERIDO a propósito — ver `BalanceLane`. */
    private readonly lane: BalanceLane,
    opts: RefreshDebtorBalancesOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  async execute(): Promise<RefreshDebtorBalancesResult> {
    let refreshed = 0;
    let skipped = 0;
    let errors = 0;
    const at = this.now();

    // Enumerate debtors, inactives and bajas via paginated clientes_consulta.
    // Each status bucket is isolated: if fetchClients fails for one estado, we
    // log the error, count it, and continue with the next estado. Clients already
    // enumerated from prior estados are still refreshed.
    // Use a Set to deduplicate in case a client appears in more than one bucket
    // (defensive against dirty data / race conditions — not a structural concern).
    const clientIdSet = new Set<string>();

    for (const estado of this.lane.estados) {
      let offset = 0;
      let countForStatus = 0;

      try {
        while (true) {
          const { total, clients } = await this.gr.fetchClients({
            cantidad: this.pageSize,
            offset,
            estado,
          });
          for (const c of clients) {
            clientIdSet.add(c.grClienteId);
            countForStatus++;
          }
          offset += this.pageSize;
          if (clients.length === 0 || offset >= total) break;
        }

        console.log(`[${this.lane.logPrefix}] Estado ${estado}: ${countForStatus} cliente(s) enumerado(s)`);
      } catch (err) {
        console.error(`[${this.lane.logPrefix}] Enumeration failure for estado ${estado}:`, (err as Error).message);
        errors++;
        // Continue with the next estado — do not abort the whole batch
      }
    }

    console.log(`[${this.lane.logPrefix}] Total únicos a refrescar: ${clientIdSet.size}`);

    // Fetch and store balance for each unique client, one at a time
    for (const grClienteId of clientIdSet) {
      try {
        const balance = await this.gr.fetchClientBalance(grClienteId);
        await this.mirror.updateClientBalance(grClienteId, balance.amount, balance.currency, at);
        // Sync the client's GR invoices from the SAME payload (zero extra GR calls).
        // Guard (review #1): if GR reports debt (amount > 0) but returns NO itemized
        // invoices, the list is non-authoritative (schema drift / partial payload) — a
        // blind replace-all would wipe the mirror and reintroduce the $0-vs-debt bug this
        // feature kills. Sync only when authoritative: non-empty, or genuine zero-debt (paid off).
        if (balance.invoices.length > 0 || balance.amount <= 0) {
          await this.mirror.upsertInvoices(grClienteId, balance.invoices, at);
        }
        refreshed++;
      } catch (err) {
        console.error(`[${this.lane.logPrefix}] Error refreshing ${grClienteId}:`, (err as Error).message);
        errors++;
      }
    }

    // lastResult:
    //   'ok'       — at least one client was refreshed, or there was nothing to do
    //                (no enumeration/balance errors).
    //   'error: …' — there were errors (enumeration AND/OR balance) and NOTHING was
    //                refreshed. Covers both "GR unreachable during enumeration" and
    //                "enumeration ok but the balance endpoint is fully down".
    const lastResult =
      errors > 0 && refreshed === 0
        ? `error: ${errors} failure(s), no clients refreshed`
        : 'ok';

    await this.state.save({
      entity: this.lane.entity,
      cursor: null,
      lastRunAt: at,
      lastResult,
      itemsSynced: refreshed,
    });

    return { refreshed, skipped, errors };
  }
}

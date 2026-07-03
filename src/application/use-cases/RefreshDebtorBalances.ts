import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { ClientMirrorRepository } from '@domain/ports/ClientMirrorRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';

const SYNC_ENTITY = 'gr-debtor-balances';
/** Estados GR que requieren balance: Deudor (2), Inactivo (3), Baja (6). */
const DEBTOR_LIKE_STATUSES = ['2', '3', '6'] as const;
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
 * Batch use case: fetch the outstanding balance for every debtor (estado=2),
 * inactive (estado=3) and baja (estado=6) client, and persist it via
 * ClientMirrorRepository.updateClientBalance.
 *
 * Iterates all three status buckets sequentially; deduplicates client ids
 * via a Set before fetching balances.
 * One client failure logs and continues — the batch never aborts mid-loop.
 * Wholesale failure (e.g. GR unreachable when enumerating) is caught,
 * recorded in SyncState (same pattern as SyncGestionRealClients), and
 * returned as an error result (never re-thrown).
 *
 * ⚠️  Volume note: estado=3 (Inactivos) may be a large set and increase
 * GR API call count substantially. Add throttling/rate-limit handling if
 * GR starts returning 429s.
 */
export class RefreshDebtorBalances {
  private readonly now: () => Date;
  private readonly pageSize: number;

  constructor(
    private readonly gr: GestionRealPort,
    private readonly mirror: ClientMirrorRepository,
    private readonly state: SyncStateRepository,
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

    for (const estado of DEBTOR_LIKE_STATUSES) {
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

        console.log(`[gr-balance] Estado ${estado}: ${countForStatus} cliente(s) enumerado(s)`);
      } catch (err) {
        console.error(`[gr-balance] Enumeration failure for estado ${estado}:`, (err as Error).message);
        errors++;
        // Continue with the next estado — do not abort the whole batch
      }
    }

    console.log(`[gr-balance] Total únicos a refrescar: ${clientIdSet.size}`);

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
        console.error(`[gr-balance] Error refreshing debtor ${grClienteId}:`, (err as Error).message);
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
      entity: SYNC_ENTITY,
      cursor: null,
      lastRunAt: at,
      lastResult,
      itemsSynced: refreshed,
    });

    return { refreshed, skipped, errors };
  }
}

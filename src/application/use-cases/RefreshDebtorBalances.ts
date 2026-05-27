import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { ClientMirrorRepository } from '@domain/ports/ClientMirrorRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';

const SYNC_ENTITY = 'gr-debtor-balances';
const DEBTOR_STATUS_CODE = '2';
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
 * Batch use case: fetch the outstanding balance for every debtor (estado=2)
 * and persist it via ClientMirrorRepository.updateClientBalance.
 *
 * Bounded to ~167 GR calls (only debtors), never the full ~5589.
 * One debtor failure logs and continues — the batch never aborts mid-loop.
 * Wholesale failure (e.g. GR unreachable when enumerating) is caught,
 * recorded in SyncState (same pattern as SyncGestionRealClients), and
 * returned as an error result (never re-thrown).
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

    try {
      // Enumerate all debtors via paginated clientes_consulta with estado=2
      const debtorIds: string[] = [];
      let offset = 0;

      while (true) {
        const { total, clients } = await this.gr.fetchClients({
          cantidad: this.pageSize,
          offset,
          estado: DEBTOR_STATUS_CODE,
        });
        for (const c of clients) {
          debtorIds.push(c.grClienteId);
        }
        offset += this.pageSize;
        if (clients.length === 0 || offset >= total) break;
      }

      // Fetch and store balance for each debtor, one at a time
      for (const grClienteId of debtorIds) {
        try {
          const balance = await this.gr.fetchClientBalance(grClienteId);
          await this.mirror.updateClientBalance(grClienteId, balance.amount, balance.currency, at);
          refreshed++;
        } catch (err) {
          console.error(`[gr-balance] Error refreshing debtor ${grClienteId}:`, (err as Error).message);
          errors++;
        }
      }

      await this.state.save({
        entity: SYNC_ENTITY,
        cursor: null,
        lastRunAt: at,
        lastResult: 'ok',
        itemsSynced: refreshed,
      });
    } catch (err) {
      const message = (err as Error).message;
      console.error('[gr-balance] Wholesale failure:', message);
      errors++;
      await this.state.save({
        entity: SYNC_ENTITY,
        cursor: null,
        lastRunAt: at,
        lastResult: `error: ${message}`,
        itemsSynced: refreshed,
      });
    }

    return { refreshed, skipped, errors };
  }
}

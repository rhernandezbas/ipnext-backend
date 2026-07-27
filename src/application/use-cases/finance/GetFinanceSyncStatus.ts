import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { deltaCursorHasPendingPages } from './SyncGrReceiptsDelta';
import { isValidYearMonth } from './financeDates';

const DELTA_ENTITY = 'finance-receipts-delta';
const BACKFILL_ENTITY = 'finance-receipts-backfill';
const DEBTOR_BALANCES_ENTITY = 'gr-debtor-balances';
/** finance-growth Fase 3 rework (J3) — SAME entity key `FinanceSnapshotScheduler` writes to via `SyncStateRepository`. */
export const SNAPSHOT_JOB_ENTITY = 'finance-snapshot-job';

export interface FinanceDeltaStatus {
  lastRunAt: Date | null;
  lastResult: string | null;
  itemsSynced: number;
  /** True while a "hasta hoy" range still has unpaged pages (composite cursor). */
  pendingPages: boolean;
  /** Last day fully covered by a completed run ("DD-MM-AAAA"), or null while pending. */
  coveredThroughDate: string | null;
}

export interface FinanceBackfillStatus {
  lastRunAt: Date | null;
  lastResult: string | null;
  itemsSynced: number;
  /** Month currently being (or next to be) backfilled, walking newest→oldest. */
  cursorYearMonth: string | null;
  cursorPageOffset: number;
  /** True once the backfill reached the configured floor and completed it. */
  done: boolean;
}

export interface FinanceDebtorBalancesStatus {
  lastRunAt: Date | null;
  lastResult: string | null;
  itemsSynced: number;
}

/** finance-growth Fase 3 rework (J3) — same shape as `FinanceDebtorBalancesStatus`, kept as its own named type for clarity at the call site. */
export interface FinanceSnapshotJobStatus {
  lastRunAt: Date | null;
  lastResult: string | null;
  itemsSynced: number;
}

export interface FinanceSyncStatus {
  delta: FinanceDeltaStatus;
  backfill: FinanceBackfillStatus;
  debtorBalances: FinanceDebtorBalancesStatus;
  snapshotJob: FinanceSnapshotJobStatus;
}

/**
 * finance-growth Fase 1 — `GET /api/finance/growth/sync/status` (design.md
 * "GET /sync/status"). Derives `pendingPages`/`coveredThroughDate` and
 * `cursorYearMonth`/`cursorPageOffset`/`done` from the SAME cursor-encoding
 * convention the ingest use cases write (Decision 4b) — reads
 * `SyncStateRepository` directly, NEVER `GestionRealPort` (Decision 5). The
 * in-memory pacing snapshot (`effectiveIntervalMs`/`degraded`/`activeLane`)
 * lives on `FinanceReceiptIngestScheduler` — infrastructure-only — and is
 * merged in by the ROUTE, not this use case.
 */
export class GetFinanceSyncStatus {
  constructor(private readonly state: SyncStateRepository) {}

  async execute(): Promise<FinanceSyncStatus> {
    const [delta, backfill, debtor, snapshotJob] = await Promise.all([
      this.state.get(DELTA_ENTITY),
      this.state.get(BACKFILL_ENTITY),
      this.state.get(DEBTOR_BALANCES_ENTITY),
      this.state.get(SNAPSHOT_JOB_ENTITY),
    ]);

    const pendingPages = deltaCursorHasPendingPages(delta?.cursor ?? null);
    const deltaStatus: FinanceDeltaStatus = {
      lastRunAt: delta?.lastRunAt ?? null,
      lastResult: delta?.lastResult ?? null,
      itemsSynced: delta?.itemsSynced ?? 0,
      pendingPages,
      coveredThroughDate: delta?.cursor && !pendingPages ? delta.cursor : null,
    };

    let cursorYearMonth: string | null = null;
    let cursorPageOffset = 0;
    let done = false;
    if (backfill) {
      if (backfill.cursor === null) {
        done = true;
      } else {
        // fix-wave-1 F14: a corrupt cursor with no ':' at all must report
        // "unknown" (null), never a garbage substring sliced off the raw
        // value (e.g. `"garbage".slice(0, -1)` → `"garbag"`).
        // fix-wave-2 LOW (F14 residual): this only validated `idx === -1`,
        // NOT the `isValidYearMonth` shape — a truncated legacy cursor like
        // "2026-0:5" (already treated as CORRUPT and reset by
        // `SyncGrReceiptsBackfillBatch`/`SyncGrReceiptsDelta`, see their own
        // `isValidYearMonth` guards) would still slice cleanly here and
        // report a bogus `cursorYearMonth: "2026-0"` on `/sync/status`,
        // instead of the same "unknown" (null) the use cases already treat
        // it as internally.
        const idx = backfill.cursor.lastIndexOf(':');
        const candidateYearMonth = idx === -1 ? null : backfill.cursor.slice(0, idx);
        if (candidateYearMonth === null || !isValidYearMonth(candidateYearMonth)) {
          cursorYearMonth = null;
          cursorPageOffset = 0;
        } else {
          cursorYearMonth = candidateYearMonth;
          cursorPageOffset = Number(backfill.cursor.slice(idx + 1)) || 0;
        }
      }
    }
    const backfillStatus: FinanceBackfillStatus = {
      lastRunAt: backfill?.lastRunAt ?? null,
      lastResult: backfill?.lastResult ?? null,
      itemsSynced: backfill?.itemsSynced ?? 0,
      cursorYearMonth,
      cursorPageOffset,
      done,
    };

    const debtorBalances: FinanceDebtorBalancesStatus = {
      lastRunAt: debtor?.lastRunAt ?? null,
      lastResult: debtor?.lastResult ?? null,
      itemsSynced: debtor?.itemsSynced ?? 0,
    };

    const snapshotJobStatus: FinanceSnapshotJobStatus = {
      lastRunAt: snapshotJob?.lastRunAt ?? null,
      lastResult: snapshotJob?.lastResult ?? null,
      itemsSynced: snapshotJob?.itemsSynced ?? 0,
    };

    return { delta: deltaStatus, backfill: backfillStatus, debtorBalances, snapshotJob: snapshotJobStatus };
  }
}

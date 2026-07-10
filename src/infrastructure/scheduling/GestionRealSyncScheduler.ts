import { SyncGestionRealClients, SyncRunResult } from '@application/use-cases/SyncGestionRealClients';
import { SyncGestionRealContracts, ContractSyncResult } from '@application/use-cases/SyncGestionRealContracts';
import { SyncGestionRealContractsDelta, ContractDeltaResult } from '@application/use-cases/SyncGestionRealContractsDelta';
import { BackfillGrContractsBatch, BackfillBatchResult } from '@application/use-cases/BackfillGrContractsBatch';
import { DistributedLock } from '@domain/ports/DistributedLock';

export interface SchedulerOptions {
  intervalMs: number;
  /** Suppress console logging (tests). */
  silent?: boolean;
}

export interface RunSummary {
  skipped?: boolean;
  error?: string;
  clients?: SyncRunResult;
  contracts?: ContractSyncResult;
  /** Result of the one bounded contract-backfill batch run this tick (when armed). */
  backfill?: BackfillBatchResult;
  /** Result of the global contract delta sync (when wired). */
  contractsDelta?: ContractDeltaResult;
  /** Result of the ownership-transfer case detector (when wired). */
  ownershipCases?: unknown;
}

/** Key used for the distributed lock — all replicas must agree on this string. */
const LOCK_KEY = 'gr-sync';

/**
 * In-process scheduler for the Gestión Real mirror. Runs client sync then
 * contract sync on a fixed interval.
 *
 * Two layers of protection against overlapping runs:
 *  1. `inFlight` flag — intra-process guard (fast, no I/O).
 *  2. `DistributedLock` — cross-process/replica guard (backed by Postgres
 *     advisory locks in production, in-memory fake in tests).
 *
 * Errors are swallowed so one bad cycle never kills the timer.
 *
 * Lifecycle is owned by main.ts and only started when GR_SYNC_ENABLED=true.
 */
export class GestionRealSyncScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly syncClients: SyncGestionRealClients,
    private readonly syncContracts: SyncGestionRealContracts,
    private readonly opts: SchedulerOptions,
    private readonly lock: DistributedLock,
    /**
     * Optional resumable contract backfill. When provided, runOnce() drains
     * exactly ONE bounded batch per tick (no-op when disarmed). Omitted in
     * tests/contexts that don't exercise the backfill.
     */
    private readonly backfill?: BackfillGrContractsBatch,
    /**
     * Optional global contract delta sync (by modification date). When provided,
     * runs AFTER the per-client contract sync so newly-mirrored clients are available.
     * Errors are swallowed like the rest of the cycle — one bad delta doesn't kill the timer.
     */
    private readonly syncContractsDelta?: SyncGestionRealContractsDelta,
    /**
     * Optional ownership-transfer case detector (actions-worklist DET-1). When
     * provided, runs AFTER the contract delta so status/motivoBaja flips from this
     * tick are already visible in the mirror. Structural type (not the use case
     * class) — the scheduler only needs `execute()`. Errors are swallowed like the
     * delta pata — one bad detection never kills the timer.
     */
    private readonly detectOwnershipCases?: { execute(): Promise<unknown> },
  ) {}

  start(): void {
    this.log(`[gr-sync] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    // Don't keep the event loop alive just for the sync timer.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[gr-sync] stopped');
  }

  async runOnce(): Promise<RunSummary> {
    // Layer 1: intra-process guard (no I/O, cheap).
    if (this.inFlight) {
      this.log('[gr-sync] skipped — previous run still in flight');
      return { skipped: true };
    }

    // Layer 2: distributed guard (cross-replica).
    const acquired = await this.lock.tryAcquire(LOCK_KEY);
    if (!acquired) {
      this.log('[gr-sync] skipped — lock held by another instance');
      return { skipped: true };
    }

    this.inFlight = true;
    try {
      const clients = await this.syncClients.execute();
      // In backfill, fetching contracts for every client = one GR call each (thousands).
      // Only the newly-created clients need it; a re-backfill of existing rows skips them.
      // In delta, the touched set is already small (only modified clients).
      const contractIds = clients.mode === 'backfill' ? clients.createdClientIds : clients.touchedClientIds;
      const contracts = await this.syncContracts.execute(contractIds);

      // Drain ONE bounded contract-backfill batch if armed. Bounded ⇒ the
      // gr-sync lock is held seconds, not hours; a restart resumes from the
      // persisted offset. No-op when disarmed.
      let backfill: BackfillBatchResult | undefined;
      if (this.backfill) backfill = await this.backfill.execute();

      // Run the global contract delta (by modification date). Runs AFTER the
      // client-sync so newly-created clients are already in the mirror.
      // Error is swallowed — one bad delta tick never kills the interval.
      let contractsDelta: ContractDeltaResult | undefined;
      if (this.syncContractsDelta) {
        try {
          contractsDelta = await this.syncContractsDelta.execute();
        } catch (deltaErr) {
          this.log(`[gr-sync] contract-delta ERROR (swallowed): ${(deltaErr as Error).message}`);
        }
      }

      // Detect ownership-transfer cases from the freshly-synced mirror. Runs AFTER
      // the delta so this tick's status/motivoBaja flips are already visible.
      // Error is swallowed — one bad detection never kills the interval.
      let ownershipCases: unknown;
      if (this.detectOwnershipCases) {
        try {
          ownershipCases = await this.detectOwnershipCases.execute();
        } catch (detectErr) {
          this.warn(`[gr-sync] ownership-detect ERROR (swallowed): ${(detectErr as Error).message}`);
        }
      }

      this.log(
        `[gr-sync] ${clients.mode}: clients +${clients.created}/~${clients.updated}, ` +
        `contracts +${contracts.created}/~${contracts.updated}` +
        (backfill && backfill.processed
          ? `, backfill ${backfill.processed} (@${backfill.nextOffset}${backfill.done ? ' done' : ''})`
          : '') +
        (contractsDelta && !contractsDelta.skippedFlag
          ? `, delta +${contractsDelta.created}/~${contractsDelta.updated}`
          : ''),
      );
      return { clients, contracts, backfill, contractsDelta, ownershipCases };
    } catch (err) {
      const message = (err as Error).message;
      this.log(`[gr-sync] ERROR: ${message}`);
      return { error: message };
    } finally {
      this.inFlight = false;
      await this.lock.release(LOCK_KEY);
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }

  private warn(msg: string): void {
    if (!this.opts.silent) console.warn(msg);
  }
}

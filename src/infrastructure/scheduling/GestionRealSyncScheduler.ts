import { SyncGestionRealClients, SyncRunResult } from '@application/use-cases/SyncGestionRealClients';
import { SyncGestionRealContracts, ContractSyncResult } from '@application/use-cases/SyncGestionRealContracts';
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
      this.log(
        `[gr-sync] ${clients.mode}: clients +${clients.created}/~${clients.updated}, ` +
        `contracts +${contracts.created}/~${contracts.updated}`,
      );
      return { clients, contracts };
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
}

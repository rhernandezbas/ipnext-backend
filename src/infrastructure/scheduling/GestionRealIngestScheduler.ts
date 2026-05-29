import { IngestGestionRealOrders, IngestRunResult } from '@application/use-cases/IngestGestionRealOrders';
import { GestionRealIngestConfigRepository } from '@domain/ports/GestionRealIngestConfigRepository';
import { DistributedLock } from '@domain/ports/DistributedLock';

export interface IngestSchedulerOptions {
  intervalMs: number;
  /** Suppress console logging (tests). */
  silent?: boolean;
}

export interface IngestRunSummary {
  skipped?: boolean;
  error?: string;
  result?: IngestRunResult;
}

/**
 * Key used for the distributed lock — all replicas must agree on this string.
 * DISTINCT from the GR mirror sync (`gr-sync`) so the two schedulers never
 * block each other (PgAdvisoryLock hashes the key → distinct string, distinct lock).
 */
const LOCK_KEY = 'gr-ingest';

/**
 * In-process scheduler for the Gestión Real installation-order ingest. Runs
 * IngestGestionRealOrders on a fixed interval, mirroring GestionRealSyncScheduler.
 *
 * Two layers of protection against overlapping runs:
 *  1. `inFlight` flag — intra-process guard (fast, no I/O).
 *  2. `DistributedLock` — cross-process/replica guard (Postgres advisory lock in
 *     production, in-memory fake in tests).
 *
 * The feature is toggled at runtime via the persisted config's `enabled` flag —
 * checked per tick so it can be flipped via `PUT /config` without a redeploy.
 * When disabled the tick is a no-op (the use-case itself also no-ops, but we
 * short-circuit here to avoid acquiring the lock needlessly).
 *
 * Errors are swallowed so one bad cycle never kills the timer.
 */
export class GestionRealIngestScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly ingest: IngestGestionRealOrders,
    private readonly config: GestionRealIngestConfigRepository,
    private readonly opts: IngestSchedulerOptions,
    private readonly lock: DistributedLock,
  ) {}

  start(): void {
    this.log(`[gr-ingest] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    // Don't keep the event loop alive just for the ingest timer.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[gr-ingest] stopped');
  }

  async runOnce(): Promise<IngestRunSummary> {
    // Runtime toggle: skip entirely when disabled (REQ-SCHED-2). Avoids touching
    // the lock or GR when the operator has not turned the feature on.
    const cfg = await this.config.get();
    if (!cfg.enabled) {
      this.log('[gr-ingest] skipped — disabled');
      return { skipped: true };
    }

    // Layer 1: intra-process guard (no I/O, cheap).
    if (this.inFlight) {
      this.log('[gr-ingest] skipped — previous run still in flight');
      return { skipped: true };
    }

    // Layer 2: distributed guard (cross-replica) (REQ-SCHED-1).
    const acquired = await this.lock.tryAcquire(LOCK_KEY);
    if (!acquired) {
      this.log('[gr-ingest] skipped — lock held by another instance');
      return { skipped: true };
    }

    this.inFlight = true;
    try {
      const result = await this.ingest.execute();
      this.log(
        `[gr-ingest] done: created=${result.created}, ` +
        `duplicate=${result.skippedDuplicate}, unmirrored=${result.skippedUnmirrored}, ` +
        `unclassified=${result.unclassified}`,
      );
      return { result };
    } catch (err) {
      const message = (err as Error).message;
      this.log(`[gr-ingest] ERROR: ${message}`);
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

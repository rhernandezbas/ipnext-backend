import { IngestGestionRealOrders, IngestRunResult } from '@application/use-cases/IngestGestionRealOrders';
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

/** Max skipped-order detail lines per tick — the full list lives in GET /status. */
const MAX_SKIP_LOG_LINES = 10;

/**
 * In-process scheduler for the Gestión Real installation-order ingest. Runs
 * IngestGestionRealOrders on a fixed interval, mirroring GestionRealSyncScheduler.
 *
 * Two layers of protection against overlapping runs:
 *  1. `inFlight` flag — intra-process guard (fast, no I/O).
 *  2. `DistributedLock` — cross-process/replica guard (Postgres advisory lock in
 *     production, in-memory fake in tests).
 *
 * The feature is toggled at runtime via the `gestion-real-ingest` feature flag,
 * which is the single on/off gate and is checked inside the use-case per run.
 * The scheduler simply ticks and delegates; when the flag is OFF the use-case
 * no-ops (zero counts, no GR call).
 *
 * Errors are swallowed so one bad cycle never kills the timer.
 */
export class GestionRealIngestScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly ingest: IngestGestionRealOrders,
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
    // The runtime on/off gate is the `gestion-real-ingest` feature flag, checked
    // inside the use-case. The scheduler always ticks; a flag-OFF run is a cheap
    // no-op in the use-case (zero counts, no GR call).

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
      // Surface WHICH orders the mirror is blocking — `unmirrored=N` alone
      // forced log+DB archaeology to find the client to repair in GR. Capped:
      // skips are stable across ticks (until someone repairs the mirror), so
      // an uncapped loop would re-flood the log every interval.
      for (const s of result.skippedOrders.slice(0, MAX_SKIP_LOG_LINES)) {
        this.log(
          `[gr-ingest] skipped orden ${s.grOrdenId}: ${s.reason} ` +
          `(cliente ${s.grClienteId ?? '?'}, contrato ${s.grContratoId ?? '?'})`,
        );
      }
      const unlogged = result.skippedOrders.length - MAX_SKIP_LOG_LINES;
      if (unlogged > 0) this.log(`[gr-ingest] ... y ${unlogged} más (ver GET /status)`);
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

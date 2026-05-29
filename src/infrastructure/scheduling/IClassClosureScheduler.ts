import { IngestClosedServiceOrders, IngestClosedCounts } from '@application/use-cases/IngestClosedServiceOrders';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { DistributedLock } from '@domain/ports/DistributedLock';

/** Feature flag gating the closure loop (default OFF — flip it on after rollout). */
const FLAG_KEY = 'iclass-closure-loop';
/** Advisory lock key — distinct from 'gr-sync' / 'gr-ingest'. */
const LOCK_KEY = 'iclass-closed';

export interface ClosureSchedulerOptions {
  intervalMs: number;
  silent?: boolean;
}

export interface ClosureRunSummary {
  skipped?: boolean;
  error?: string;
  counts?: IngestClosedCounts;
}

/**
 * In-process scheduler for the IClass closure loop. Mirrors GestionRealSyncScheduler
 * (inFlight + DistributedLock + fixed interval, errors swallowed) and re-reads the
 * `iclass-closure-loop` feature flag on every tick, so it can be toggled without a
 * redeploy. Starts dormant (flag default OFF).
 */
export class IClassClosureScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly ingest: IngestClosedServiceOrders,
    private readonly flags: FeatureFlagRepository,
    private readonly opts: ClosureSchedulerOptions,
    private readonly lock: DistributedLock,
  ) {}

  start(): void {
    this.log(`[iclass-closure] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[iclass-closure] stopped');
  }

  async runOnce(): Promise<ClosureRunSummary> {
    if (this.inFlight) {
      this.log('[iclass-closure] skipped — previous run still in flight');
      return { skipped: true };
    }

    const flag = await this.flags.get(FLAG_KEY);
    if (!flag?.enabled) {
      this.log('[iclass-closure] skipped — flag off');
      return { skipped: true };
    }

    const acquired = await this.lock.tryAcquire(LOCK_KEY);
    if (!acquired) {
      this.log('[iclass-closure] skipped — lock held by another instance');
      return { skipped: true };
    }

    this.inFlight = true;
    try {
      const counts = await this.ingest.execute();
      this.log(
        `[iclass-closure] mirrored=${counts.mirrored} moved=${counts.transitioned} ` +
        `notClosed=${counts.skippedNotClosed} notOurs=${counts.skippedNotOurs} unchanged=${counts.skippedUnchanged}`,
      );
      return { counts };
    } catch (err) {
      const message = (err as Error).message;
      this.log(`[iclass-closure] ERROR: ${message}`);
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

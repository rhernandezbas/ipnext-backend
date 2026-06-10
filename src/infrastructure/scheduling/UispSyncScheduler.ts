import type { SyncUispMirror } from '@application/use-cases/SyncUispMirror';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { SyncStateRepository } from '@domain/ports/SyncStateRepository';

const LOCK_KEY = 'uisp-sync';
const FLAG_KEY = 'uisp-sync';

export interface UispSyncSchedulerOptions {
  intervalMs: number;
  silent?: boolean;
}

export interface UispSyncRunSummary {
  skipped?: boolean;
  error?: string;
  sitesUpserted?: number;
  devicesUpserted?: number;
}

export type TriggerResult =
  | { queued: true }
  | { queued: false; reason: 'already-running' | 'flag-disabled' };

/**
 * In-process scheduler for the UISP mirror sync.
 * Mirrors TaskAutocompleteScheduler: inFlight + DistributedLock + flag gate + triggerNow().
 *
 * Gates:
 * 1. sync is null (env not configured) → skip with log
 * 2. feature flag 'uisp-sync' is OFF → skip
 * 3. advisory lock 'uisp-sync' held → skip (another replica is running)
 * 4. inFlight → skip (previous run not yet done)
 */
export class UispSyncScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly sync: SyncUispMirror | null,
    private readonly flags: FeatureFlagRepository,
    private readonly lock: DistributedLock,
    private readonly opts: UispSyncSchedulerOptions,
    /** Optional — when provided, a failed sync persists SyncState with lastResult='error: <msg>' */
    private readonly syncStateRepo?: SyncStateRepository,
  ) {}

  start(): void {
    this.log(`[uisp-sync] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[uisp-sync] stopped');
  }

  /**
   * Manual trigger from HTTP POST /api/uisp/sync.
   * Returns immediately — actual run is fire-and-forget.
   */
  async triggerNow(): Promise<TriggerResult> {
    if (this.inFlight) return { queued: false, reason: 'already-running' };
    const flag = await this.flags.get(FLAG_KEY);
    if (!flag?.enabled) return { queued: false, reason: 'flag-disabled' };
    void this.runOnce();
    return { queued: true };
  }

  async runOnce(): Promise<UispSyncRunSummary> {
    if (this.sync === null) {
      this.log('[uisp-sync] skipped — not configured (UISP_BASE_URL/UISP_TOKEN absent)');
      return { skipped: true };
    }

    // FIX-4: set inFlight SYNCHRONOUSLY before any await so two concurrent calls
    // in the same process can't both slip through the check (pg advisory lock is
    // re-entrant within the same session, so the lock alone is not enough).
    if (this.inFlight) {
      this.log('[uisp-sync] skipped — previous run still in flight');
      return { skipped: true };
    }
    this.inFlight = true;

    try {
      const flag = await this.flags.get(FLAG_KEY);
      if (!flag?.enabled) {
        this.log('[uisp-sync] skipped — flag disabled');
        return { skipped: true };
      }

      const acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[uisp-sync] skipped — lock held by another instance');
        return { skipped: true };
      }

      try {
        const result = await this.sync.execute();
        this.log(`[uisp-sync] done — sites=${result.sitesUpserted} devices=${result.devicesUpserted} durationMs=${result.durationMs}`);
        return { sitesUpserted: result.sitesUpserted, devicesUpserted: result.devicesUpserted };
      } catch (err) {
        const message = (err as Error).message;
        this.log(`[uisp-sync] ERROR: ${message}`);
        // FIX-2a: persist error SyncState so GetUispSyncStatus can surface lastError
        if (this.syncStateRepo) {
          await this.syncStateRepo.save({
            entity: 'uisp-mirror',
            cursor: null,
            lastRunAt: new Date(),
            lastResult: `error: ${message}`,
            itemsSynced: 0,
          }).catch(() => { /* ignore — best effort */ });
        }
        return { error: message };
      } finally {
        await this.lock.release(LOCK_KEY);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}

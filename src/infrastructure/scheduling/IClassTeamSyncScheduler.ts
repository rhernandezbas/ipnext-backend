import type { SyncIClassTeams, SyncTeamsResult } from '@application/use-cases/SyncIClassTeams';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { DistributedLock } from '@domain/ports/DistributedLock';

/**
 * In-process scheduler for the IClass team catalog sync (#134).
 *
 * Before this scheduler, SyncIClassTeams only ran on a manual POST
 * /api/admin/iclass/teams/sync — the catalog went stale (technicians created in
 * IClass never appeared; logins IClass later cancelled stayed active+selectable
 * forever, so every schedule slot sent for them got rejected). This mirrors
 * TeamLocationIngestScheduler/IClassClosureScheduler: inFlight + DistributedLock
 * + fixed interval, errors swallowed (never crashes the process), and the
 * `iclass-team-sync` feature flag is re-read on EVERY tick so it can be toggled
 * without a redeploy. Starts dormant (flag absent → OFF) — same contract as the
 * other IClass schedulers.
 */

/** Feature flag gating the sync. Default OFF until an operator turns it on. */
const FLAG_KEY = 'iclass-team-sync';
/** Advisory lock key — distinct from the other IClass locks ('iclass-closed', 'team-locations'). */
const LOCK_KEY = 'iclass-team-sync';

export interface IClassTeamSyncSchedulerOptions {
  intervalMs: number;
  silent?: boolean;
}

export interface IClassTeamSyncRunResult {
  skipped?: boolean;
  error?: string;
  result?: SyncTeamsResult;
}

export class IClassTeamSyncScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly sync: SyncIClassTeams,
    private readonly flags: FeatureFlagRepository,
    private readonly opts: IClassTeamSyncSchedulerOptions,
    private readonly lock: DistributedLock,
  ) {}

  start(): void {
    this.log(`[iclass-team-sync] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    // unref: the scheduler must never keep the process alive on its own.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[iclass-team-sync] stopped');
  }

  async runOnce(): Promise<IClassTeamSyncRunResult> {
    if (this.inFlight) {
      this.log('[iclass-team-sync] skipped — previous run still in flight');
      return { skipped: true };
    }

    // flags.get / lock.tryAcquire live INSIDE the try (same R8 fix as
    // TeamLocationIngestScheduler): callers invoke `void runOnce()`, so a rejection
    // here would be an unhandled rejection that kills the process in Node >= 15.
    let acquired = false;
    try {
      const flag = await this.flags.get(FLAG_KEY);
      if (!flag?.enabled) {
        this.log('[iclass-team-sync] skipped — flag off');
        return { skipped: true };
      }

      acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[iclass-team-sync] skipped — lock held by another instance');
        return { skipped: true };
      }
    } catch (err) {
      const message = (err as Error).message;
      this.log(`[iclass-team-sync] ERROR resolving flag/lock: ${message}`);
      return { error: message };
    }

    this.inFlight = true;
    try {
      const result = await this.sync.execute();
      this.log(
        `[iclass-team-sync] synced=${result.synced} created=${result.created} updated=${result.updated} ` +
        `reactivated=${result.reactivated} deactivated=${result.deactivated} cancelled=${result.cancelled}`,
      );
      return { result };
    } catch (err) {
      // IClassUnavailableError / rate-limit / any other transport failure: logged
      // and swallowed. A failed tick must never crash the process — the next tick
      // (or the manual sync route) will retry.
      const message = (err as Error).message;
      this.log(`[iclass-team-sync] ERROR: ${message}`);
      return { error: message };
    } finally {
      this.inFlight = false;
      try {
        await this.lock.release(LOCK_KEY);
      } catch (releaseErr) {
        this.log(`[iclass-team-sync] failed to release lock: ${(releaseErr as Error).message}`);
      }
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}

/**
 * SuricataSyncScheduler (suricata-tickets-mirror, Phase C, task C.9, D0/D14) —
 * molde EXACTO `ChatMediaDownloadScheduler`:
 *   - setInterval + timer.unref()
 *   - inFlight flag (intra-proceso, síncrono antes del primer await)
 *   - DistributedLock cross-replica con key 'suricata-sync'
 *   - Feature flag gate 'suricata-sync-enabled' (dark by default, D14 step 2)
 *   - Una corrida que lanza NO tumba el scheduler
 *   - runOnce() exportado para tests
 */
import type { SyncSuricataTickets } from '@application/use-cases/suricata/SyncSuricataTickets';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { SuricataSyncRunOutcome } from '@domain/entities/suricata';

const LOCK_KEY = 'suricata-sync';
const FLAG_KEY = 'suricata-sync-enabled';

export interface SuricataSyncSchedulerOptions {
  intervalMs: number;
  /** Suprimir console en tests. */
  silent?: boolean;
}

export interface SuricataSyncRunSummary {
  skipped?: boolean;
  error?: string;
  outcome?: SuricataSyncRunOutcome;
  ticketsUpserted?: number;
}

export class SuricataSyncScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly syncUseCase: SyncSuricataTickets,
    private readonly opts: SuricataSyncSchedulerOptions,
    private readonly lock: DistributedLock,
    private readonly flags: FeatureFlagRepository,
  ) {}

  start(): void {
    this.log(`[suricata-sync] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[suricata-sync] stopped');
  }

  async runOnce(): Promise<SuricataSyncRunSummary> {
    // inFlight SÍNCRONO antes del PRIMER await -- evita que dos ticks
    // simultáneos se pisen (molde ChatMediaDownloadScheduler/CampaignRunner).
    if (this.inFlight) {
      this.log('[suricata-sync] skipped -- previous run still in flight');
      return { skipped: true };
    }
    this.inFlight = true;

    let acquired = false;
    try {
      const flag = await this.flags.get(FLAG_KEY);
      if (!flag?.enabled) {
        this.log('[suricata-sync] skipped -- flag disabled');
        return { skipped: true };
      }

      acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[suricata-sync] skipped -- lock held by another instance');
        return { skipped: true };
      }

      try {
        const run = await this.syncUseCase.execute();
        this.log(
          `[suricata-sync] done: outcome=${run.outcome} seen=${run.ticketsSeen} upserted=${run.ticketsUpserted}`,
        );
        return { outcome: run.outcome, ticketsUpserted: run.ticketsUpserted };
      } catch (err) {
        const message = (err as Error).message;
        this.log(`[suricata-sync] ERROR: ${message}`);
        return { error: message };
      } finally {
        if (acquired) await this.lock.release(LOCK_KEY);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}

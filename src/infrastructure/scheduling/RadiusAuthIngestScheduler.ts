/**
 * RadiusAuthIngestScheduler — scheduler de ingest de eventos de auth RADIUS (radpostauth).
 *
 * Espejo EXACTO de RadiusAccountingIngestScheduler:
 *   - setInterval + timer.unref()
 *   - inFlight flag (intra-proceso, síncrono antes del primer await)
 *   - DistributedLock cross-replica con key 'radius-auth-ingest'
 *   - Feature flag gate 'radius-auth-ingest' (dark by default)
 *   - Errores swallowed -> SyncState.lastResult='error: ...'
 *   - runOnce() exportado para tests
 */
import type { IngestRadiusAuth, IngestAuthRunResult } from '@application/use-cases/IngestRadiusAuth';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { SyncStateRepository } from '@domain/ports/SyncStateRepository';

const LOCK_KEY = 'radius-auth-ingest';
const FLAG_KEY = 'radius-auth-ingest';

export interface AuthIngestSchedulerOptions {
  intervalMs: number;
  /** Suprimir console en tests. */
  silent?: boolean;
}

export interface AuthIngestRunSummary {
  skipped?: boolean;
  error?: string;
  result?: IngestAuthRunResult;
}

export class RadiusAuthIngestScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly ingest:     IngestRadiusAuth,
    private readonly opts:       AuthIngestSchedulerOptions,
    private readonly lock:       DistributedLock,
    private readonly flags:      FeatureFlagRepository,
    /** Opcional: cuando provisto, un ciclo fallido persiste SyncState.lastResult='error:...' */
    private readonly stateRepo?: SyncStateRepository,
  ) {}

  start(): void {
    this.log(`[radius-auth-ingest] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    // No mantener el event loop vivo solo por el timer.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[radius-auth-ingest] stopped');
  }

  async runOnce(): Promise<AuthIngestRunSummary> {
    // inFlight SÍNCRONO antes del PRIMER await: el advisory lock de PG es re-entrante en la
    // misma sesión; sin este guard intra-proceso dos ticks simultáneos se pisarían.
    if (this.inFlight) {
      this.log('[radius-auth-ingest] skipped -- previous run still in flight');
      return { skipped: true };
    }
    this.inFlight = true;

    // OUTER try: garantiza inFlight=false SIEMPRE, incluso si flags.get o tryAcquire lanzan.
    let acquired = false;
    try {
      // Gate de feature flag (dark by default), tras el inFlight check para no malgastar el lock.
      const flag = await this.flags.get(FLAG_KEY);
      if (!flag?.enabled) {
        this.log('[radius-auth-ingest] skipped -- flag disabled');
        return { skipped: true };
      }

      // Distributed lock cross-replica.
      acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[radius-auth-ingest] skipped -- lock held by another instance');
        return { skipped: true };
      }

      try {
        const result = await this.ingest.run();
        this.log(
          `[radius-auth-ingest] done: upserted=${result.upserted} pages=${result.pages} ` +
          `purged=${result.purgedRows} cursor=${result.newCursor ?? 'none'}`,
        );
        return { result };
      } catch (err) {
        const message = (err as Error).message;
        this.log(`[radius-auth-ingest] ERROR: ${message}`);
        if (this.stateRepo) {
          await this.stateRepo.save({
            entity:      LOCK_KEY,
            cursor:      null,
            lastRunAt:   new Date(),
            lastResult:  `error: ${message}`,
            itemsSynced: 0,
          }).catch(() => { /* ignore */ });
        }
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

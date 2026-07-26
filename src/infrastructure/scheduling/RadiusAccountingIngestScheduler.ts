/**
 * RadiusAccountingIngestScheduler — scheduler de ingest de accounting RADIUS.
 *
 * Patron EXACTO de GestionRealIngestScheduler:
 *   - setInterval + timer.unref()
 *   - inFlight flag (intra-proceso, sincrono antes del primer await)
 *   - DistributedLock cross-replica con key 'radius-accounting-ingest'
 *   - Feature flag gate 'radius-accounting-ingest' (dark by default)
 *   - Errores swallowed -> SyncState.lastResult='error: ...'
 *   - runOnce() exportado para tests
 *
 * spec.md REQ-SCHED-1..4
 */
import type { IngestRadiusAccounting, IngestRunResult } from '@application/use-cases/IngestRadiusAccounting';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { SyncStateRepository, SyncState } from '@domain/ports/SyncStateRepository';

const LOCK_KEY = 'radius-accounting-ingest';
const FLAG_KEY = 'radius-accounting-ingest';

export interface IngestSchedulerOptions {
  intervalMs: number;
  /** Suprimir console en tests. */
  silent?: boolean;
}

export interface IngestRunSummary {
  skipped?: boolean;
  error?: string;
  result?: IngestRunResult;
}

export class RadiusAccountingIngestScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly ingest:     IngestRadiusAccounting,
    private readonly opts:       IngestSchedulerOptions,
    private readonly lock:       DistributedLock,
    private readonly flags:      FeatureFlagRepository,
    /** Opcional: cuando provisto, un ciclo fallido persiste SyncState.lastResult='error:...' */
    private readonly stateRepo?: SyncStateRepository,
  ) {}

  start(): void {
    this.log(`[radius-ingest] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    // REQ-SCHED-4: no mantener el event loop vivo solo por el timer.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[radius-ingest] stopped');
  }

  async runOnce(): Promise<IngestRunSummary> {
    // inFlight SINCRONO antes del PRIMER await (igual que UispSyncScheduler).
    // El advisory lock de PG es re-entrante en la misma sesion; sin este guard intra-proceso
    // dos ticks simultaneos pasarian el lock y se pisarian entre si.
    if (this.inFlight) {
      this.log('[radius-ingest] skipped -- previous run still in flight');
      return { skipped: true };
    }
    this.inFlight = true;

    // OUTER try: garantiza que inFlight=false SIEMPRE, incluso si flags.get o tryAcquire lanzan.
    // Patron EXACTO de UispSyncScheduler (ver commit de referencia).
    let acquired = false;
    try {
      // REQ-SCHED-1: gate de feature flag (dark by default)
      // Verificado despues del inFlight check para no desperdiciar el lock.
      const flag = await this.flags.get(FLAG_KEY);
      if (!flag?.enabled) {
        this.log('[radius-ingest] skipped -- flag disabled');
        return { skipped: true };
      }

      // REQ-SCHED-2: distributed lock cross-replica
      acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[radius-ingest] skipped -- lock held by another instance');
        return { skipped: true };
      }

      try {
        const result = await this.ingest.run();
        this.log(
          `[radius-ingest] done: upserted=${result.upserted} pages=${result.pages} ` +
          `purged=${result.purgedRows} cursor=${result.newCursor ?? 'none'}`,
        );
        return { result };
      } catch (err) {
        const message = (err as Error).message;
        this.log(`[radius-ingest] ERROR: ${message}`);
        // Best-effort: persistir error en SyncState para visibilidad operacional
        if (this.stateRepo) {
          // El cursor NO se toca cuando falla (incidente 2026-07-26 — mismo bug que en
          // RadiusAuthIngestScheduler, que ahí YA había explotado). Guardar `cursor: null`
          // borraba la marca de agua y condenaba al tick siguiente a re-leer toda la
          // historia: lote más grande -> más chance de timeout -> otro borrado. Espiral
          // hasta agotar el heap. Preservándolo, la falla queda acotada al mismo delta.
          // Si NO se puede leer el estado previo no se escribe NADA (espejo del scheduler
          // de auth): el ingest suele fallar POR la DB, y un `cursor: null` de fallback
          // reintroduciría la espiral justo cuando la DB está sufriendo.
          let prev: SyncState | null = null;
          let canWrite = true;
          try {
            prev = await this.stateRepo.get(LOCK_KEY);
          } catch {
            canWrite = false;
          }
          if (canWrite) {
            await this.stateRepo.save({
              entity:      LOCK_KEY,
              cursor:      prev?.cursor ?? null,
              lastRunAt:   new Date(),
              lastResult:  `error: ${message}`,
              itemsSynced: 0,
            }).catch(() => { /* ignore */ });
          }
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

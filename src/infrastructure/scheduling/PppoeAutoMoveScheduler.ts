/**
 * PppoeAutoMoveScheduler — scheduler del watcher auto-move de PPPoE (pppoe-move-nas W2,
 * REQ-AUTO-4 / design D-W2.3).
 *
 * Espejo EXACTO de RadiusAuthIngestScheduler:
 *   - setInterval + timer.unref()
 *   - inFlight flag (reentrancy intra-proceso, síncrono antes del primer await)
 *   - DistributedLock cross-replica con key 'pppoe-auto-move'
 *   - Feature flag gate 'pppoe-auto-move' chequeado EN CADA tick (dark by default; prender/
 *     apagar desde la Config UI SIN deploy ni restart — S7.1/S7.3)
 *   - Errores swallowed (un tick fallido NUNCA tumba el proceso ni el timer)
 *   - runOnce() exportado para tests
 *   - log ESTRUCTURADO por tick con el resumen del run (sessions/mismatches/moved/skips/failed)
 */
import type { AutoMovePppoe, AutoMovePppoeSummary } from '@application/use-cases/AutoMovePppoe';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

const LOCK_KEY = 'pppoe-auto-move';
const FLAG_KEY = 'pppoe-auto-move';

export interface AutoMoveSchedulerOptions {
  intervalMs: number;
  /** Suprimir console en tests. */
  silent?: boolean;
}

export interface AutoMoveRunSummary {
  skipped?: boolean;
  error?: string;
  result?: AutoMovePppoeSummary;
}

export class PppoeAutoMoveScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly autoMove: AutoMovePppoe,
    private readonly opts:     AutoMoveSchedulerOptions,
    private readonly lock:     DistributedLock,
    private readonly flags:    FeatureFlagRepository,
  ) {}

  start(): void {
    this.log(`[pppoe-auto-move] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    // No mantener el event loop vivo solo por el timer.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[pppoe-auto-move] stopped');
  }

  async runOnce(): Promise<AutoMoveRunSummary> {
    // inFlight SÍNCRONO antes del PRIMER await: el advisory lock de PG es re-entrante en la
    // misma sesión; sin este guard intra-proceso dos ticks simultáneos se pisarían.
    if (this.inFlight) {
      this.log('[pppoe-auto-move] skipped -- previous run still in flight');
      return { skipped: true };
    }
    this.inFlight = true;

    // OUTER try: garantiza inFlight=false SIEMPRE, incluso si flags.get o tryAcquire lanzan.
    let acquired = false;
    try {
      // Gate de feature flag (dark by default), tras el inFlight check para no malgastar el lock.
      const flag = await this.flags.get(FLAG_KEY);
      if (!flag?.enabled) {
        this.log('[pppoe-auto-move] skipped -- flag disabled');
        return { skipped: true };
      }

      // Distributed lock cross-replica.
      acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[pppoe-auto-move] skipped -- lock held by another instance');
        return { skipped: true };
      }

      try {
        const r = await this.autoMove.run();
        // D-W2.5 item 8: summary honesto — el log estructurado incluye los counters del
        // endurecimiento (breaker/cap/cooldown/re-verify/terminated/freshness/conflicto).
        this.log(
          `[pppoe-auto-move] tick: sessions=${r.sessions} mismatches=${r.mismatches} moved=${r.moved} ` +
          `failed=${r.failed} aborted=${r.aborted} deferred=${r.deferred} ` +
          `skippedPublic=${r.skippedPublic} skippedUnknownNas=${r.skippedUnknownNas} ` +
          `skippedCooldown=${r.skippedCooldown} alreadyConverged=${r.alreadyConverged} ` +
          `skippedTerminated=${r.skippedTerminated} skippedStale=${r.skippedStale} ` +
          `nasConflicts=${r.nasConflicts} throttled=${r.throttled} ignoredNoService=${r.ignoredNoService}`,
        );
        return { result: r };
      } catch (err) {
        const message = (err as Error).message;
        this.log(`[pppoe-auto-move] ERROR: ${message}`);
        return { error: message };
      } finally {
        if (acquired) await this.lock.release(LOCK_KEY);
      }
    } catch (err) {
      // D-W2.5 item 9: catch PROPIO del cuerpo del tick. Un throw ANTES del run (flags.get,
      // lock.tryAcquire, lock.release) rechazaba runOnce() y el `void this.runOnce()` del
      // timer quedaba como unhandled rejection. El tick falla, el scheduler sigue vivo.
      const message = (err as Error).message;
      this.log(`[pppoe-auto-move] tick ERROR (flag/lock): ${message}`);
      return { error: message };
    } finally {
      this.inFlight = false;
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}

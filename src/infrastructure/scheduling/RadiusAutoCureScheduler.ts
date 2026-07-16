/**
 * RadiusAutoCureScheduler — scheduler del watcher de auto-curación de sesiones RADIUS colgadas
 * (radius-session-autocure BE-1, REQ-CURE-4/7).
 *
 * Clon EXACTO de PppoeAutoMoveScheduler:
 *   - setInterval + timer.unref()
 *   - inFlight flag (reentrancy intra-proceso, síncrono antes del primer await)
 *   - DistributedLock cross-replica con key 'radius-auto-cure'
 *   - Feature flag 'radius-auto-cure' chequeado EN CADA tick (dark by default; prender/apagar
 *     desde la Config UI SIN deploy ni restart)
 *   - Errores swallowed (un tick fallido NUNCA tumba el proceso ni el timer)
 *   - runOnce() exportado para tests
 *   - log ESTRUCTURADO por tick con el resumen del run
 */
import type { AutoCureStuckSessions, AutoCureStuckSessionsSummary } from '@application/use-cases/AutoCureStuckSessions';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

const LOCK_KEY = 'radius-auto-cure';
const FLAG_KEY = 'radius-auto-cure';

export interface RadiusAutoCureSchedulerOptions {
  intervalMs: number;
  /** Suprimir console en tests. */
  silent?: boolean;
}

export interface RadiusAutoCureRunSummary {
  skipped?: boolean;
  error?: string;
  result?: AutoCureStuckSessionsSummary;
}

export class RadiusAutoCureScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly autoCure: AutoCureStuckSessions,
    private readonly opts: RadiusAutoCureSchedulerOptions,
    private readonly lock: DistributedLock,
    private readonly flags: FeatureFlagRepository,
  ) {}

  start(): void {
    this.log(`[radius-auto-cure] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    // No mantener el event loop vivo solo por el timer.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[radius-auto-cure] stopped');
  }

  async runOnce(): Promise<RadiusAutoCureRunSummary> {
    // inFlight SÍNCRONO antes del PRIMER await: el advisory lock de PG es re-entrante en la
    // misma sesión; sin este guard intra-proceso dos ticks simultáneos se pisarían.
    if (this.inFlight) {
      this.log('[radius-auto-cure] skipped -- previous run still in flight');
      return { skipped: true };
    }
    this.inFlight = true;

    // OUTER try: garantiza inFlight=false SIEMPRE, incluso si flags.get o tryAcquire lanzan.
    let acquired = false;
    try {
      // Gate de feature flag (dark by default), tras el inFlight check para no malgastar el lock.
      const flag = await this.flags.get(FLAG_KEY);
      if (!flag?.enabled) {
        this.log('[radius-auto-cure] skipped -- flag disabled');
        return { skipped: true };
      }

      // Distributed lock cross-replica.
      acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[radius-auto-cure] skipped -- lock held by another instance');
        return { skipped: true };
      }

      try {
        const r = await this.autoCure.run();
        this.log(
          `[radius-auto-cure] tick: events=${r.events} candidates=${r.candidates} ` +
          `cured=${r.cured} alreadyCured=${r.alreadyCured} failed=${r.failed} ` +
          `skippedAlive=${r.skippedAlive} skippedAmbiguous=${r.skippedAmbiguous} ` +
          `skippedNoSession=${r.skippedNoSession} skippedNoSignal=${r.skippedNoSignal} ` +
          `skippedCureThrottle=${r.skippedCureThrottle} flaggedFlapping=${r.flaggedFlapping} ` +
          `deferred=${r.deferred} throttled=${r.throttled} aborted=${r.aborted}`,
        );
        return { result: r };
      } catch (err) {
        const message = (err as Error).message;
        this.log(`[radius-auto-cure] ERROR: ${message}`);
        return { error: message };
      } finally {
        if (acquired) await this.lock.release(LOCK_KEY);
      }
    } catch (err) {
      // Catch PROPIO del cuerpo del tick (molde D-W2.5 item 9): un throw ANTES del run
      // (flags.get, lock.tryAcquire, lock.release) rechazaba runOnce() y el `void
      // this.runOnce()` del timer quedaba como unhandled rejection. El tick falla, el
      // scheduler sigue vivo.
      const message = (err as Error).message;
      this.log(`[radius-auto-cure] tick ERROR (flag/lock): ${message}`);
      return { error: message };
    } finally {
      this.inFlight = false;
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}

/**
 * SnoozeReactivationScheduler — watcher que reactiva las conversaciones snoozed vencidas
 * (conversation-snooze Ola 6c, opción a). COMPLEMENTA la derivación lazy de los buckets
 * (opción b, ya correcta sin cron): acá se normaliza el status en DB (higiene) y se emite un
 * evento 'unsnoozed' limpio.
 *
 * Clon del RadiusAutoCureScheduler:
 *   - setInterval + timer.unref()
 *   - inFlight flag (reentrancy intra-proceso, síncrono antes del primer await)
 *   - DistributedLock cross-replica con key 'snooze-reactivation'
 *   - Feature flag 'snooze-reactivation' chequeado EN CADA tick (dark by default; prender/apagar
 *     desde la Config UI SIN deploy ni restart)
 *   - Errores swallowed (un tick fallido NUNCA tumba el proceso ni el timer)
 *   - runOnce() exportado para tests
 */
import type { ReactivateExpiredSnoozes, ReactivateExpiredSnoozesSummary } from '@application/use-cases/messaging/ReactivateExpiredSnoozes';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

const LOCK_KEY = 'snooze-reactivation';
const FLAG_KEY = 'snooze-reactivation';

export interface SnoozeReactivationSchedulerOptions {
  intervalMs: number;
  /** Suprimir console en tests. */
  silent?: boolean;
}

export interface SnoozeReactivationRunSummary {
  skipped?: boolean;
  error?: string;
  result?: ReactivateExpiredSnoozesSummary;
}

export class SnoozeReactivationScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly reactivate: ReactivateExpiredSnoozes,
    private readonly opts: SnoozeReactivationSchedulerOptions,
    private readonly lock: DistributedLock,
    private readonly flags: FeatureFlagRepository,
  ) {}

  start(): void {
    this.log(`[snooze-reactivation] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[snooze-reactivation] stopped');
  }

  async runOnce(): Promise<SnoozeReactivationRunSummary> {
    // inFlight SÍNCRONO antes del PRIMER await: sin este guard intra-proceso dos ticks
    // simultáneos se pisarían (el advisory lock de PG es re-entrante en la misma sesión).
    if (this.inFlight) {
      this.log('[snooze-reactivation] skipped -- previous run still in flight');
      return { skipped: true };
    }
    this.inFlight = true;

    let acquired = false;
    try {
      // Gate de feature flag (dark by default), tras el inFlight check para no malgastar el lock.
      const flag = await this.flags.get(FLAG_KEY);
      if (!flag?.enabled) {
        this.log('[snooze-reactivation] skipped -- flag disabled');
        return { skipped: true };
      }

      acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[snooze-reactivation] skipped -- lock held by another instance');
        return { skipped: true };
      }

      try {
        const r = await this.reactivate.run();
        this.log(`[snooze-reactivation] tick: candidates=${r.candidates} reactivated=${r.reactivated} failed=${r.failed}`);
        return { result: r };
      } catch (err) {
        const message = (err as Error).message;
        this.log(`[snooze-reactivation] ERROR: ${message}`);
        return { error: message };
      } finally {
        if (acquired) await this.lock.release(LOCK_KEY);
      }
    } catch (err) {
      // Catch PROPIO del cuerpo del tick: un throw ANTES del run (flags.get, lock.tryAcquire,
      // lock.release) rechazaría runOnce() y el `void this.runOnce()` del timer quedaría como
      // unhandled rejection. El tick falla, el scheduler sigue vivo.
      const message = (err as Error).message;
      this.log(`[snooze-reactivation] tick ERROR (flag/lock): ${message}`);
      return { error: message };
    } finally {
      this.inFlight = false;
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}

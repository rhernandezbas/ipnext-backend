/**
 * AutoProvisionFiberScheduler — scheduler del watcher full-auto de fibra
 * (K3 fiber-auto-watcher).
 *
 * Clon EXACTO del molde RadiusAutoCureScheduler:
 *   - setInterval + timer.unref()
 *   - inFlight flag (overlap-guard: reentrancy intra-proceso, síncrono antes del primer await)
 *   - DistributedLock cross-replica con key 'fiber-auto-provision-watcher'
 *   - Feature flag 'fiber-auto-provision-watcher' chequeado EN CADA tick (dark by default;
 *     prender/apagar desde la Config UI SIN deploy ni restart). SEPARADO del flag del
 *     wizard 'fiber-auto-provision': el botón manual y el watcher son independientes.
 *   - Errores swallowed (un tick fallido NUNCA tumba el proceso ni el timer)
 *   - runOnce() exportado para tests
 *   - log ESTRUCTURADO por tick con los counters del run
 */
import type { AutoProvisionFiberOnusSummary } from '@application/use-cases/AutoProvisionFiberOnus';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

const LOCK_KEY = 'fiber-auto-provision-watcher';
const FLAG_KEY = 'fiber-auto-provision-watcher';

/** Lo único que el scheduler necesita del use case (testeable con stub). */
export interface FiberAutoProvisionRunner {
  run(): Promise<AutoProvisionFiberOnusSummary>;
}

export interface AutoProvisionFiberSchedulerOptions {
  intervalMs: number;
  /** Suprimir console en tests. */
  silent?: boolean;
}

export interface AutoProvisionFiberRunSummary {
  skipped?: boolean;
  error?: string;
  result?: AutoProvisionFiberOnusSummary;
}

export class AutoProvisionFiberScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly watcher: FiberAutoProvisionRunner,
    private readonly opts: AutoProvisionFiberSchedulerOptions,
    private readonly lock: DistributedLock,
    private readonly flags: FeatureFlagRepository,
  ) {}

  start(): void {
    this.log(`[fiber-auto-watcher] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    // No mantener el event loop vivo solo por el timer.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[fiber-auto-watcher] stopped');
  }

  async runOnce(): Promise<AutoProvisionFiberRunSummary> {
    // inFlight SÍNCRONO antes del PRIMER await: el advisory lock de PG es re-entrante en la
    // misma sesión; sin este guard intra-proceso dos ticks simultáneos se pisarían
    // (overlap-guard: un tick largo por provisions secuenciales NO se solapa con el próximo).
    if (this.inFlight) {
      this.log('[fiber-auto-watcher] skipped -- previous run still in flight');
      return { skipped: true };
    }
    this.inFlight = true;

    // OUTER try: garantiza inFlight=false SIEMPRE, incluso si flags.get o tryAcquire lanzan.
    let acquired = false;
    try {
      // Gate de feature flag (dark by default), tras el inFlight check para no malgastar el lock.
      const flag = await this.flags.get(FLAG_KEY);
      if (!flag?.enabled) {
        this.log('[fiber-auto-watcher] skipped -- flag disabled');
        return { skipped: true };
      }

      // Distributed lock cross-replica.
      acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[fiber-auto-watcher] skipped -- lock held by another instance');
        return { skipped: true };
      }

      try {
        const r = await this.watcher.run();
        this.log(
          `[fiber-auto-watcher] tick: candidates=${r.candidates} unconfigured=${r.unconfigured} ` +
          `matched=${r.matched} provisioned=${r.provisioned} failed=${r.failed} skipped=${r.skipped}`,
        );
        return { result: r };
      } catch (err) {
        const message = (err as Error).message;
        this.log(`[fiber-auto-watcher] ERROR: ${message}`);
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
      this.log(`[fiber-auto-watcher] tick ERROR (flag/lock): ${message}`);
      return { error: message };
    } finally {
      this.inFlight = false;
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}

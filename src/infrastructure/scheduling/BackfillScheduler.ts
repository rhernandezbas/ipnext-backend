import { BackfillClosedServiceOrders } from '@application/use-cases/BackfillClosedServiceOrders';
import { DistributedLock } from '@domain/ports/DistributedLock';

/** Advisory lock key — distinto de 'task-autocomplete' / 'iclass-closed'. */
const LOCK_KEY = 'iclass-closure-backfill';

export type BackfillTriggerResult =
  | { queued: true }
  | { queued: false; reason: 'already-running' };

export interface BackfillRunResult {
  skipped?: boolean;
  error?: string;
}

/**
 * Scheduler on-demand para el backfill de service orders cerradas (#32).
 * Sin cron ni setInterval — sólo disparo manual vía triggerNow().
 *
 * Mirrors la mitad del guard de TaskAutocompleteScheduler:
 *   - inFlight boolean evita ejecuciones paralelas en la misma instancia.
 *   - PgAdvisoryLock('iclass-closure-backfill') evita colisiones cross-instance.
 *   - triggerNow() retorna inmediatamente (fire-and-forget de runOnce).
 */
export class BackfillScheduler {
  private inFlight = false;

  constructor(
    private readonly backfill: BackfillClosedServiceOrders,
    private readonly lock: DistributedLock,
    private readonly opts: { silent?: boolean } = {},
  ) {}

  /**
   * Disparo on-demand: lanza runOnce en fire-and-forget y retorna {queued:true}.
   * Si ya hay un run en vuelo, retorna {queued:false, reason:'already-running'} sin
   * iniciar un segundo run paralelo.
   */
  async triggerNow(): Promise<BackfillTriggerResult> {
    if (this.inFlight) return { queued: false, reason: 'already-running' };
    void this.runOnce();
    return { queued: true };
  }

  /**
   * Ejecuta el backfill una vez. Adquiere el advisory lock antes de ejecutar;
   * libera el lock y resetea inFlight en el bloque finally.
   */
  async runOnce(): Promise<BackfillRunResult> {
    if (this.inFlight) {
      this.log('[backfill-scheduler] skipped — previous run still in flight');
      return { skipped: true };
    }

    const acquired = await this.lock.tryAcquire(LOCK_KEY);
    if (!acquired) {
      this.log('[backfill-scheduler] skipped — lock held by another instance');
      return { skipped: true };
    }

    this.inFlight = true;
    try {
      const r = await this.backfill.execute();
      this.log(`[backfill-scheduler] done — mirrored=${r.mirrored} transitioned=${r.transitioned} failed=${r.failed}`);
      return {};
    } catch (err) {
      const message = (err as Error).message;
      this.log(`[backfill-scheduler] ERROR: ${message}`);
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

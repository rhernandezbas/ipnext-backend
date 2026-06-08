import { ReprocessClosureSideEffects } from '@application/use-cases/ReprocessClosureSideEffects';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { DistributedLock } from '@domain/ports/DistributedLock';

/** Advisory lock key — distinct from 'iclass-closed' / 'gr-sync'. */
const LOCK_KEY = 'task-autocomplete';

/** Clave de flag para el disparo manual (independiente del flag del cron). */
const MANUAL_FLAG_KEY = 'iclass-closure-reprocess';

export interface TaskAutocompleteSchedulerOptions {
  intervalMs: number;
  silent?: boolean;
}

export interface TaskAutocompleteRunSummary {
  skipped?: boolean;
  error?: string;
  processed?: number;
}

export type TriggerResult =
  | { queued: true }
  | { queued: false; reason: 'already-running' | 'flag-disabled' };

/**
 * In-process scheduler for the task auto-complete (#14). Mirrors IClassClosureScheduler
 * (inFlight + DistributedLock + fixed interval, errors swallowed). It re-runs the
 * existing ReprocessClosureSideEffects — instantiated with flagKey 'task-autocomplete'
 * — which itself checks that flag and re-fires the pending closure side-effects
 * (comment/audit/inventory). Starts dormant (flag default OFF). No new closure logic.
 *
 * A partir de #23: expone `triggerNow()` para el endpoint HTTP manual. El run manual
 * usa una instancia separada de ReprocessClosureSideEffects ligada al flag
 * 'iclass-closure-reprocess', totalmente independiente del flag del cron.
 */
export class TaskAutocompleteScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    /** Instancia del cron — usa flagKey 'task-autocomplete'. */
    private readonly reprocess: ReprocessClosureSideEffects,
    private readonly opts: TaskAutocompleteSchedulerOptions,
    private readonly lock: DistributedLock,
    /** Repositorio de feature flags para leer 'iclass-closure-reprocess' en triggerNow. */
    private readonly flags: FeatureFlagRepository = { list: async () => [], get: async () => null, setEnabled: async () => ({ key: '', enabled: false, updatedAt: '' }) },
    /** Instancia manual — usa flagKey 'iclass-closure-reprocess'. */
    private readonly manualReprocess: ReprocessClosureSideEffects = reprocess,
  ) {}

  start(): void {
    this.log(`[task-autocomplete] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[task-autocomplete] stopped');
  }

  /**
   * Disparo manual desde HTTP: lee solo el flag manual (lectura rápida), devuelve
   * el resultado de forma síncrona y lanza runOnce en fire-and-forget.
   */
  async triggerNow(): Promise<TriggerResult> {
    if (this.inFlight) return { queued: false, reason: 'already-running' };
    const flag = await this.flags.get(MANUAL_FLAG_KEY);
    if (!flag?.enabled) return { queued: false, reason: 'flag-disabled' };
    void this.runOnce(this.manualReprocess);
    return { queued: true };
  }

  /**
   * Corre el reprocess una vez. El parámetro permite al trigger manual usar la
   * instancia ligada al flag 'iclass-closure-reprocess' en lugar del cron.
   * Comparten inFlight + advisory lock → solo una ejecución a la vez.
   */
  async runOnce(reprocess: ReprocessClosureSideEffects = this.reprocess): Promise<TaskAutocompleteRunSummary> {
    if (this.inFlight) {
      this.log('[task-autocomplete] skipped — previous run still in flight');
      return { skipped: true };
    }

    const acquired = await this.lock.tryAcquire(LOCK_KEY);
    if (!acquired) {
      this.log('[task-autocomplete] skipped — lock held by another instance');
      return { skipped: true };
    }

    this.inFlight = true;
    try {
      // execute() checks its own flag internally → skipped when OFF.
      const r = await reprocess.execute();
      if (r.skipped) {
        this.log('[task-autocomplete] skipped — flag off');
        return { skipped: true };
      }
      this.log(`[task-autocomplete] processed=${r.processed} candidates=${r.candidates} noTask=${r.noTask}`);
      return { processed: r.processed };
    } catch (err) {
      const message = (err as Error).message;
      this.log(`[task-autocomplete] ERROR: ${message}`);
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

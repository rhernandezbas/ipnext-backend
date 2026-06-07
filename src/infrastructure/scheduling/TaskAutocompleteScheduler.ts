import { ReprocessClosureSideEffects } from '@application/use-cases/ReprocessClosureSideEffects';
import { DistributedLock } from '@domain/ports/DistributedLock';

/** Advisory lock key — distinct from 'iclass-closed' / 'gr-sync'. */
const LOCK_KEY = 'task-autocomplete';

export interface TaskAutocompleteSchedulerOptions {
  intervalMs: number;
  silent?: boolean;
}

export interface TaskAutocompleteRunSummary {
  skipped?: boolean;
  error?: string;
  processed?: number;
}

/**
 * In-process scheduler for the task auto-complete (#14). Mirrors IClassClosureScheduler
 * (inFlight + DistributedLock + fixed interval, errors swallowed). It re-runs the
 * existing ReprocessClosureSideEffects — instantiated with flagKey 'task-autocomplete'
 * — which itself checks that flag and re-fires the pending closure side-effects
 * (comment/audit/inventory). Starts dormant (flag default OFF). No new closure logic.
 */
export class TaskAutocompleteScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly reprocess: ReprocessClosureSideEffects,
    private readonly opts: TaskAutocompleteSchedulerOptions,
    private readonly lock: DistributedLock,
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

  async runOnce(): Promise<TaskAutocompleteRunSummary> {
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
      // execute() checks the 'task-autocomplete' flag internally → skipped when OFF.
      const r = await this.reprocess.execute();
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

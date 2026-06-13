import type { CancelTv } from '@application/use-cases/gigared/CancelTv';
import type { ClientTvCancelStatusRepository } from '@domain/ports/ClientTvCancelStatusRepository';

/**
 * CancelTvJobRunner (#10/#11) — async wrapper for the synchronous CancelTv use case.
 *
 * Mirrors the BackfillScheduler fire-and-forget pattern:
 *   - `run()` is the real worker: sets tvCancelStatus='running' + tvCancelStartedAt,
 *     calls cancelTv.execute(), on success writes tvCancelStatus='done' + tvCancelResult,
 *     on throw writes tvCancelStatus='failed' + tvCancelResult={error}.
 *   - The route calls `void runner.run(...)` (fire-and-forget) after setting status='pending'.
 *
 * There is no inFlight guard here — the route guards against concurrent runs by checking
 * tvCancelStatus === 'running' | 'pending' BEFORE queuing, and setting 'pending' atomically
 * before firing. The runner's transition from pending→running is fast (DB write only).
 *
 * CancelTv itself stays SYNCHRONOUS and unchanged — this runner is the async shell.
 */
export class CancelTvJobRunner {
  constructor(
    private readonly cancelTv: CancelTv,
    private readonly cancelStatus: ClientTvCancelStatusRepository,
  ) {}

  /**
   * Runs the TV cancellation job for a customer + contract.
   * Always writes the final status (done or failed) before resolving.
   * Never throws — all errors are written to cancelStatus.
   */
  async run(customerId: string, contractId: string): Promise<void> {
    const startedAt = new Date();
    // Transition: pending → running
    await this.cancelStatus.setStatus(customerId, { status: 'running', startedAt });

    try {
      const result = await this.cancelTv.execute(customerId, { contractId });
      await this.cancelStatus.setStatus(customerId, { status: 'done', result, startedAt });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.cancelStatus.setStatus(customerId, { status: 'failed', result: { error }, startedAt });
    }
  }
}

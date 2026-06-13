import type { CancelTv } from '@application/use-cases/gigared/CancelTv';
import type { ClientTvCancelStatusRepository } from '@domain/ports/ClientTvCancelStatusRepository';
import type { TvActivationEventRepository } from '@domain/ports/TvActivationEventRepository';

export interface CancelTvActor {
  actorId: string | null;
  actorName: string;
}

/**
 * CancelTvJobRunner (#10/#11 / #5 BE) — async wrapper for the synchronous CancelTv use case.
 *
 * Mirrors the BackfillScheduler fire-and-forget pattern:
 *   - `run()` is the real worker: sets tvCancelStatus='running' + tvCancelStartedAt,
 *     calls cancelTv.execute(), on success writes tvCancelStatus='done' + tvCancelResult,
 *     on throw writes tvCancelStatus='failed' + tvCancelResult={error}.
 *   - The route calls `void runner.run(...)` (fire-and-forget) after setting status='pending'.
 *
 * #5 BE — `eventRepo` is OPTIONAL for backwards compatibility. When provided:
 *   - On success ('done'), records a 'baja' TvActivationEvent with the actor threaded from run().
 *   - The event record is best-effort: if it throws, the cancel status is still written.
 *   - On failure ('failed'), NO event is recorded (the cancel did not complete).
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
    private readonly eventRepo?: TvActivationEventRepository,
  ) {}

  /**
   * Runs the TV cancellation job for a customer + contract.
   * Always writes the final status (done or failed) before resolving.
   * Never throws — all errors are written to cancelStatus.
   *
   * @param actor — optional actor info threaded from the cancel route (req.user). Defaults to
   *               null actorId + empty actorName when not provided (system-initiated or legacy).
   */
  async run(customerId: string, contractId: string, actor?: CancelTvActor): Promise<void> {
    const startedAt = new Date();
    // Transition: pending → running
    await this.cancelStatus.setStatus(customerId, { status: 'running', startedAt });

    try {
      const result = await this.cancelTv.execute(customerId, { contractId });
      await this.cancelStatus.setStatus(customerId, { status: 'done', result, startedAt });

      // #5 BE / #5B — record the 'baja' event best-effort (never abort the status write above).
      // #5B: pass result.cic (the CIC of the account at the time of the baja) and contractId
      // so history shows which CIC and contract were involved in each baja.
      if (this.eventRepo) {
        try {
          await this.eventRepo.record({
            clientId:   customerId,
            actorId:    actor?.actorId ?? null,
            actorName:  actor?.actorName ?? '',
            eventType:  'baja',
            cic:        result.cic,
            contractId: contractId,
          });
        } catch (evErr) {
          // eslint-disable-next-line no-console
          console.warn('[gigared] cancel runner: baja event record failed (best-effort)', evErr);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.cancelStatus.setStatus(customerId, { status: 'failed', result: { error }, startedAt });
    }
  }
}

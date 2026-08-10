import { SchedulingRepository, ClosureOrigin, CloseTaskResult } from '@domain/ports/SchedulingRepository';
import { TaskActivityRecorder } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

export interface ApplyTaskClosureInput {
  taskId: string;
  origin: ClosureOrigin;
  resultCode?: string | null;
  closedByUserId?: string | null;
}

/**
 * wave-1a (cierre atómico first-writer-wins) — the ONE place all 5 closers (staff via
 * SetTaskGeneralStatus/UpdateTask, iclass via IngestClosedServiceOrders, staff-with-push
 * via CloseIClassServiceOrder, and the app's CloseTaskFromField in Wave 1b) go through
 * to close a task. It wraps `SchedulingRepository.closeTaskIfOpen` (the atomic guard)
 * with EXACTLY one extra responsibility: when this call LOST the race, decide whether
 * the loser's resultCode actually conflicts with the winner's, and if so, log it +
 * record it as a `closure_conflict` activity — ONCE, here, instead of duplicated across
 * every writer. It does NOT emit the winning `status_changed` event; each writer keeps
 * doing that itself (they have different actors/messages), same as before this wave.
 */
export async function applyTaskClosure(
  repo: SchedulingRepository,
  recorder: TaskActivityRecorder | undefined,
  input: ApplyTaskClosureInput,
): Promise<CloseTaskResult> {
  const resultCode = input.resultCode ?? null;
  const result = await repo.closeTaskIfOpen(input.taskId, {
    origin: input.origin,
    resultCode,
    closedByUserId: input.closedByUserId ?? null,
  });

  if (!result.closed && result.existingResultCode !== resultCode) {
    const at = new Date().toISOString();
    // eslint-disable-next-line no-console
    console.log(
      `[task-closure-conflict] task=${input.taskId} winner=${result.existingOrigin}/${result.existingResultCode} loser=${input.origin}/${resultCode} at=${at}`,
    );
    if (recorder) {
      await recorder.record(input.taskId, 'closure_conflict', {
        actor: SYSTEM_ACTOR,
        metadata: {
          winnerOrigin: result.existingOrigin,
          winnerResultCode: result.existingResultCode,
          loserOrigin: input.origin,
          loserResultCode: resultCode,
        },
      });
    }
  }

  return result;
}

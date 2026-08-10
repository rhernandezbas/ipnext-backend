import { SchedulingRepository, ClosureOrigin, CloseTaskResult } from '@domain/ports/SchedulingRepository';
import { TaskActivityRecorder } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';
import { normalizeResultCode } from './normalizeResultCode';

export interface ApplyTaskClosureInput {
  taskId: string;
  origin: ClosureOrigin;
  resultCode?: string | null;
  closedByUserId?: string | null;
  /**
   * FIX-4(d) — set to false to SUPPRESS the discrepancy report (log + activity) for
   * this call, while still performing the atomic close. Only the ingest uses it: a
   * re-run over an SO that was ALREADY mirrored as closed is IClass repeating itself,
   * not a second independent opinion, so a bump of `iclassUpdatedAt` must not re-log
   * the same conflict on every cron tick. Defaults to true (report).
   */
  reportConflict?: boolean;
}

/**
 * FIX-4 (fix wave W1a) — is the loser's result actually in CONFLICT with the winner's?
 *
 *  - No task at all (`task === null`): there is no winner and no loser. `existingResultCode`
 *    is null because the ROW is missing, not because the winner closed without a result —
 *    reporting here would invent a conflict out of a 404.
 *  - Loser's resultCode is null: this writer contributed NO result. That is the everyday
 *    "staff cerró a mano" case (SetTaskGeneralStatus / UpdateTask always pass null), and
 *    treating it as a discrepancy floods the audit trail with `loserResultCode: null`
 *    noise that buries the real conflicts.
 *  - Both non-null: compare NORMALIZED (`normalizeResultCode`), never byte-for-byte.
 *    IClass returns the same code with cosmetic drift ("Instalacion Completa Fibra" vs
 *    "instalacion completa fibra."), and the ingest's own result-code resolver already
 *    normalizes — a stricter comparison here would contradict it and cry wolf.
 *  - Loser non-null over a winner with null: a REAL divergence (someone closed with no
 *    result and a result arrived afterwards) — still reported.
 */
function isRealConflict(result: CloseTaskResult, loserResultCode: string | null): boolean {
  if (result.closed) return false;
  if (result.task === null) return false;
  if (loserResultCode === null) return false;
  const winner = result.existingResultCode;
  if (winner === null) return true;
  return normalizeResultCode(winner) !== normalizeResultCode(loserResultCode);
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

  if ((input.reportConflict ?? true) && isRealConflict(result, resultCode)) {
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

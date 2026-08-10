import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ScheduledTask, TaskGeneralStatus } from '@domain/entities/scheduling';
import { TaskNotFoundError, InvalidGeneralStatusError } from '@domain/errors/scheduling';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';
import { applyTaskClosure } from './applyTaskClosure';

const VALID_STATUSES: readonly TaskGeneralStatus[] = ['open', 'closed', 'dismissed'];

/**
 * #41 — Set a task's lifecycle management status (open / closed / dismissed).
 *
 * Single writer for generalStatus via the dedicated endpoint. Free transitions
 * (any → any). Idempotent (D8): a no-op transition returns the task and emits no
 * activity. The recorded `status_changed` event carries STRING from/to values.
 */
export class SetTaskGeneralStatus {
  constructor(
    private readonly repo: SchedulingRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(id: string, status: string, actor?: ActorContext): Promise<ScheduledTask> {
    // Defensive validation (the route's zod guard already rejects bad values 400).
    if (!VALID_STATUSES.includes(status as TaskGeneralStatus)) {
      throw new InvalidGeneralStatusError(status);
    }

    const prev = await this.repo.getTask(id);
    if (!prev) throw new TaskNotFoundError(id);

    // D8 — idempotent no-op: same status returns the task without an event.
    if (prev.generalStatus === status) return prev;

    // wave-1a (cierre atómico) — a transition INTO 'closed' is the one with a real
    // race (staff/iclass/app can all close concurrently), so it routes through the
    // atomic guard. Losing the race is NOT an error: the same guard already decided
    // a winner (possibly this very millisecond, between the read above and now) —
    // we just return whatever won, emit no event of our own, and let
    // applyTaskClosure log/record the discrepancy if the resultCodes differ.
    if (status === 'closed') {
      const result = await applyTaskClosure(this.repo, this.recorder, {
        taskId: id,
        origin: 'staff',
        resultCode: null,
        closedByUserId: actor?.actorId ?? null,
      });
      const updated = result.task ?? await this.repo.getTask(id);
      if (!updated) throw new TaskNotFoundError(id);

      if (result.closed && this.recorder) {
        await this.recorder.record(id, 'status_changed', {
          actor: actor ?? SYSTEM_ACTOR,
          fromValue: prev.generalStatus,
          toValue: status,
        });
      }
      return updated;
    }

    const updated = await this.repo.updateTask(id, { generalStatus: status as TaskGeneralStatus });
    if (!updated) throw new TaskNotFoundError(id);

    if (this.recorder) {
      await this.recorder.record(id, 'status_changed', {
        actor: actor ?? SYSTEM_ACTOR,
        fromValue: prev.generalStatus,
        toValue: status,
      });
    }

    return updated;
  }
}

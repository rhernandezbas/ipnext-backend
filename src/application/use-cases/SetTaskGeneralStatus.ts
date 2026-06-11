import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ScheduledTask, TaskGeneralStatus } from '@domain/entities/scheduling';
import { TaskNotFoundError, InvalidGeneralStatusError } from '@domain/errors/scheduling';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

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

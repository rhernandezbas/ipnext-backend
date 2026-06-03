import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { TaskNotFoundError } from '@domain/errors/scheduling';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

export class SetTaskInventoryReview {
  constructor(
    private readonly repo: SchedulingRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(
    taskId: string,
    reviewed: boolean,
    actorId: string | null = null,
    actor?: ActorContext,
  ): Promise<ScheduledTask> {
    const updated = await this.repo.setInventoryReview(taskId, reviewed, actorId);
    if (!updated) throw new TaskNotFoundError(taskId);

    // task-activity-log (#10 / D.7): emit inventory_review_changed.
    if (this.recorder) {
      await this.recorder.record(taskId, 'inventory_review_changed', {
        actor: actor ?? SYSTEM_ACTOR,
        toValue: reviewed,
      });
    }

    return updated;
  }
}

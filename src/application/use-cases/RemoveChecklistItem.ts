import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

export class RemoveChecklistItem {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  /**
   * @param taskId Threaded from the route (`/:id/checklist/:itemId`) so the
   *   removal can be recorded — the repo's boolean result carries no taskId.
   */
  async execute(itemId: string, taskId?: string, actor?: ActorContext): Promise<boolean> {
    const removed = await this.schedulingRepo.removeChecklistItem(itemId);

    if (removed && this.recorder && taskId) {
      await this.recorder.record(taskId, 'checklist_item_removed', {
        actor: actor ?? SYSTEM_ACTOR,
        metadata: { itemId },
      });
    }

    return removed;
  }
}

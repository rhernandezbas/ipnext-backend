import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskChecklistItem } from '@domain/entities/checklist';
import { ChecklistItemNotFoundError } from '@domain/errors/checklist';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

export class ToggleChecklistItem {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(itemId: string, actor?: ActorContext): Promise<TaskChecklistItem> {
    let item: TaskChecklistItem;
    try {
      item = await this.schedulingRepo.toggleChecklistItem(itemId);
    } catch (err) {
      if (err instanceof ChecklistItemNotFoundError) throw err;
      throw new ChecklistItemNotFoundError(itemId);
    }

    if (this.recorder) {
      await this.recorder.record(item.taskId, 'checklist_item_toggled', {
        actor: actor ?? SYSTEM_ACTOR,
        toValue: { done: item.done },
        metadata: { itemId },
      });
    }

    return item;
  }
}

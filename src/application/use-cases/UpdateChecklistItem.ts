import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskChecklistItem } from '@domain/entities/checklist';
import { ChecklistItemNotFoundError } from '@domain/errors/checklist';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

export class UpdateChecklistItem {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(itemId: string, text: string, actor?: ActorContext): Promise<TaskChecklistItem> {
    let item: TaskChecklistItem;
    try {
      item = await this.schedulingRepo.updateChecklistItem(itemId, text);
    } catch (err) {
      if (err instanceof ChecklistItemNotFoundError) throw err;
      throw new ChecklistItemNotFoundError(itemId);
    }

    if (this.recorder) {
      await this.recorder.record(item.taskId, 'checklist_item_updated', {
        actor: actor ?? SYSTEM_ACTOR,
        toValue: { text: item.text },
        metadata: { itemId },
      });
    }

    return item;
  }
}

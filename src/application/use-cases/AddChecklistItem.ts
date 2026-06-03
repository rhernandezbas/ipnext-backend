import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskChecklistItem } from '@domain/entities/checklist';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

export class AddChecklistItem {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(taskId: string, text: string, actor?: ActorContext): Promise<TaskChecklistItem | null> {
    const task = await this.schedulingRepo.getTask(taskId);
    if (!task) return null;
    const item = await this.schedulingRepo.addChecklistItem(taskId, text);

    if (this.recorder) {
      await this.recorder.record(taskId, 'checklist_item_added', {
        actor: actor ?? SYSTEM_ACTOR,
        toValue: { text: item.text },
        metadata: { itemId: item.id },
      });
    }

    return item;
  }
}

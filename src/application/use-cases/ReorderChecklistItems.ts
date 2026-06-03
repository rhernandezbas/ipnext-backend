import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskChecklistItem } from '@domain/entities/checklist';
import { OrderingError } from '@domain/errors/checklist';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

export class ReorderChecklistItems {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(taskId: string, orderedIds: string[], actor?: ActorContext): Promise<TaskChecklistItem[]> {
    let items: TaskChecklistItem[];
    try {
      items = await this.schedulingRepo.reorderChecklistItems(taskId, orderedIds);
    } catch (err) {
      if (err instanceof OrderingError) throw err;
      throw err;
    }

    if (this.recorder) {
      await this.recorder.record(taskId, 'checklist_reordered', {
        actor: actor ?? SYSTEM_ACTOR,
        metadata: { orderedIds },
      });
    }

    return items;
  }
}

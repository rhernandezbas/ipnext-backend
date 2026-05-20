import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskChecklistItem } from '@domain/entities/checklist';
import { OrderingError } from '@domain/errors/checklist';

export class ReorderChecklistItems {
  constructor(private readonly schedulingRepo: SchedulingRepository) {}

  async execute(taskId: string, orderedIds: string[]): Promise<TaskChecklistItem[]> {
    try {
      return await this.schedulingRepo.reorderChecklistItems(taskId, orderedIds);
    } catch (err) {
      if (err instanceof OrderingError) throw err;
      throw err;
    }
  }
}

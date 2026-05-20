import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskChecklistItem } from '@domain/entities/checklist';
import { ChecklistItemNotFoundError } from '@domain/errors/checklist';

export class ToggleChecklistItem {
  constructor(private readonly schedulingRepo: SchedulingRepository) {}

  async execute(itemId: string): Promise<TaskChecklistItem> {
    try {
      return await this.schedulingRepo.toggleChecklistItem(itemId);
    } catch (err) {
      if (err instanceof ChecklistItemNotFoundError) throw err;
      throw new ChecklistItemNotFoundError(itemId);
    }
  }
}

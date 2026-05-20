import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskChecklistItem } from '@domain/entities/checklist';
import { ChecklistItemNotFoundError } from '@domain/errors/checklist';

export class UpdateChecklistItem {
  constructor(private readonly schedulingRepo: SchedulingRepository) {}

  async execute(itemId: string, text: string): Promise<TaskChecklistItem> {
    try {
      return await this.schedulingRepo.updateChecklistItem(itemId, text);
    } catch (err) {
      if (err instanceof ChecklistItemNotFoundError) throw err;
      throw new ChecklistItemNotFoundError(itemId);
    }
  }
}

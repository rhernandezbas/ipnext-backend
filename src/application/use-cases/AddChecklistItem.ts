import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskChecklistItem } from '@domain/entities/checklist';

export class AddChecklistItem {
  constructor(private readonly schedulingRepo: SchedulingRepository) {}

  async execute(taskId: string, text: string): Promise<TaskChecklistItem | null> {
    const task = await this.schedulingRepo.getTask(taskId);
    if (!task) return null;
    return this.schedulingRepo.addChecklistItem(taskId, text);
  }
}

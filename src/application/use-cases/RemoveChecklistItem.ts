import { SchedulingRepository } from '@domain/ports/SchedulingRepository';

export class RemoveChecklistItem {
  constructor(private readonly schedulingRepo: SchedulingRepository) {}

  async execute(itemId: string): Promise<boolean> {
    return this.schedulingRepo.removeChecklistItem(itemId);
  }
}

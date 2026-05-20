import { SchedulingRepository } from '@domain/ports/SchedulingRepository';

export class ClearTaskChecklist {
  constructor(private readonly schedulingRepo: SchedulingRepository) {}

  async execute(taskId: string): Promise<void> {
    await this.schedulingRepo.clearChecklist(taskId);
  }
}

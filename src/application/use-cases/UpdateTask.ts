import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';

export class UpdateTask {
  constructor(private readonly repo: SchedulingRepository) {}

  execute(id: string, data: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    return this.repo.updateTask(id, data);
  }
}

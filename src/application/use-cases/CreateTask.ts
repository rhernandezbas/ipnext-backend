import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';

export class CreateTask {
  constructor(private readonly repo: SchedulingRepository) {}

  execute(data: Omit<ScheduledTask, 'id'>): Promise<ScheduledTask> {
    return this.repo.createTask(data);
  }
}

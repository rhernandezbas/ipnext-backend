import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ScheduledTask, TaskStatus } from '@domain/entities/scheduling';

export class UpdateTaskStatus {
  constructor(private readonly repo: SchedulingRepository) {}

  execute(id: string, status: TaskStatus): Promise<ScheduledTask | null> {
    return this.repo.updateTaskStatus(id, status);
  }
}

import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';

export class ListTasks {
  constructor(private readonly repo: SchedulingRepository) {}

  execute(): Promise<ScheduledTask[]> {
    return this.repo.listTasks();
  }
}

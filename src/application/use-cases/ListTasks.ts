import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { TaskListFilter } from '@application/dto/scheduling.dto';

export class ListTasks {
  constructor(private readonly repo: SchedulingRepository) {}

  execute(filter?: TaskListFilter): Promise<ScheduledTask[]> {
    return this.repo.listTasks(filter);
  }
}

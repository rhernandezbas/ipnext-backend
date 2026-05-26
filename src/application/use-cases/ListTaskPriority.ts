import { TaskPriorityRepository } from '@domain/ports/TaskPriorityRepository';
import { TaskPriority } from '@domain/entities/taskPriority';

export class ListTaskPriority {
  constructor(private readonly repo: TaskPriorityRepository) {}
  async execute(): Promise<TaskPriority[]> {
    return this.repo.list();
  }
}

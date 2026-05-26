import { TaskPriorityRepository } from '@domain/ports/TaskPriorityRepository';
import { TaskPriority } from '@domain/entities/taskPriority';
import { TaskPriorityNotFoundError } from '@domain/errors/scheduling';

export class GetTaskPriority {
  constructor(private readonly repo: TaskPriorityRepository) {}
  async execute(id: string): Promise<TaskPriority> {
    const item = await this.repo.getById(id);
    if (!item) throw new TaskPriorityNotFoundError(id);
    return item;
  }
}

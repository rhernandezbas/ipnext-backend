import { TaskPriorityRepository } from '@domain/ports/TaskPriorityRepository';
import { TaskPriority } from '@domain/entities/taskPriority';
import { TaskPriorityNameConflictError } from '@domain/errors/scheduling';

export class CreateTaskPriority {
  constructor(private readonly repo: TaskPriorityRepository) {}
  async execute(data: { name: string; color: string; weight: number }): Promise<TaskPriority> {
    const existing = await this.repo.getByName(data.name);
    if (existing) throw new TaskPriorityNameConflictError(data.name);
    return this.repo.create(data);
  }
}

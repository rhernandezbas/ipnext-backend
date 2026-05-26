import { TaskPriorityRepository } from '@domain/ports/TaskPriorityRepository';
import { TaskPriority } from '@domain/entities/taskPriority';
import { TaskPriorityNotFoundError, TaskPriorityNameConflictError } from '@domain/errors/scheduling';

export class UpdateTaskPriority {
  constructor(private readonly repo: TaskPriorityRepository) {}
  async execute(id: string, data: { name?: string; color?: string; weight?: number }): Promise<TaskPriority> {
    const item = await this.repo.getById(id);
    if (!item) throw new TaskPriorityNotFoundError(id);

    if (data.name && data.name.toLowerCase() !== item.name.toLowerCase()) {
      const conflict = await this.repo.getByName(data.name);
      if (conflict && conflict.id !== id) throw new TaskPriorityNameConflictError(data.name);
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new TaskPriorityNotFoundError(id);
    return updated;
  }
}

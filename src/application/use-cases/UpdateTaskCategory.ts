import { TaskCategoryRepository } from '@domain/ports/TaskCategoryRepository';
import { TaskCategory } from '@domain/entities/taskCategory';
import { TaskCategoryNotFoundError, TaskCategoryNameConflictError } from '@domain/errors/scheduling';

export class UpdateTaskCategory {
  constructor(private readonly repo: TaskCategoryRepository) {}
  async execute(id: string, data: { name?: string; description?: string | null }): Promise<TaskCategory> {
    const item = await this.repo.getById(id);
    if (!item) throw new TaskCategoryNotFoundError(id);

    if (data.name && data.name.toLowerCase() !== item.name.toLowerCase()) {
      const conflict = await this.repo.getByName(data.name);
      if (conflict && conflict.id !== id) throw new TaskCategoryNameConflictError(data.name);
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new TaskCategoryNotFoundError(id);
    return updated;
  }
}

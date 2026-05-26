import { TaskCategoryRepository } from '@domain/ports/TaskCategoryRepository';
import { TaskCategory } from '@domain/entities/taskCategory';
import { TaskCategoryNameConflictError } from '@domain/errors/scheduling';

export class CreateTaskCategory {
  constructor(private readonly repo: TaskCategoryRepository) {}
  async execute(data: { name: string; description?: string | null }): Promise<TaskCategory> {
    const existing = await this.repo.getByName(data.name);
    if (existing) throw new TaskCategoryNameConflictError(data.name);
    return this.repo.create({ name: data.name, description: data.description ?? null });
  }
}

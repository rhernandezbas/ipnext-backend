import { TaskCategoryRepository } from '@domain/ports/TaskCategoryRepository';
import { TaskCategory } from '@domain/entities/taskCategory';
import { TaskCategoryNotFoundError } from '@domain/errors/scheduling';

export class GetTaskCategory {
  constructor(private readonly repo: TaskCategoryRepository) {}
  async execute(id: string): Promise<TaskCategory> {
    const item = await this.repo.getById(id);
    if (!item) throw new TaskCategoryNotFoundError(id);
    return item;
  }
}

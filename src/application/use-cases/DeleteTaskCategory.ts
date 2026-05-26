import { TaskCategoryRepository } from '@domain/ports/TaskCategoryRepository';
import { TaskCategoryNotFoundError, TaskCategoryInUseError } from '@domain/errors/scheduling';

export class DeleteTaskCategory {
  constructor(private readonly repo: TaskCategoryRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new TaskCategoryNotFoundError(id);

    // Tasks store their category by name (string column), so guard by name.
    const count = await this.repo.countTasksUsing(item.name);
    if (count > 0) throw new TaskCategoryInUseError(count);

    await this.repo.delete(id);
  }
}

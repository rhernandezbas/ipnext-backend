import { TaskPriorityRepository } from '@domain/ports/TaskPriorityRepository';
import { TaskPriorityNotFoundError, TaskPriorityInUseError } from '@domain/errors/scheduling';

export class DeleteTaskPriority {
  constructor(private readonly repo: TaskPriorityRepository) {}
  async execute(id: string): Promise<void> {
    const item = await this.repo.getById(id);
    if (!item) throw new TaskPriorityNotFoundError(id);

    // Tasks store their priority by name (string column), so guard by name.
    const count = await this.repo.countTasksUsing(item.name);
    if (count > 0) throw new TaskPriorityInUseError(count);

    await this.repo.delete(id);
  }
}

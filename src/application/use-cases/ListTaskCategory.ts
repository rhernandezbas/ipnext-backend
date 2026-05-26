import { TaskCategoryRepository } from '@domain/ports/TaskCategoryRepository';
import { TaskCategory } from '@domain/entities/taskCategory';

export class ListTaskCategory {
  constructor(private readonly repo: TaskCategoryRepository) {}
  async execute(): Promise<TaskCategory[]> {
    return this.repo.list();
  }
}

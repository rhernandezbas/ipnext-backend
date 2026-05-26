import { TaskCategory } from '../entities/taskCategory';

export interface TaskCategoryRepository {
  list(): Promise<TaskCategory[]>;
  getById(id: string): Promise<TaskCategory | null>;
  getByName(name: string): Promise<TaskCategory | null>;
  create(data: { name: string; description: string | null }): Promise<TaskCategory>;
  update(id: string, data: Partial<{ name: string; description: string | null }>): Promise<TaskCategory | null>;
  delete(id: string): Promise<boolean>;
  countTasksUsing(categoryName: string): Promise<number>;
}

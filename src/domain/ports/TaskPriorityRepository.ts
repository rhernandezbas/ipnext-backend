import { TaskPriority } from '../entities/taskPriority';

export interface TaskPriorityRepository {
  list(): Promise<TaskPriority[]>;
  getById(id: string): Promise<TaskPriority | null>;
  getByName(name: string): Promise<TaskPriority | null>;
  create(data: { name: string; color: string; weight: number }): Promise<TaskPriority>;
  update(id: string, data: Partial<{ name: string; color: string; weight: number }>): Promise<TaskPriority | null>;
  delete(id: string): Promise<boolean>;
  countTasksUsing(priorityName: string): Promise<number>;
}

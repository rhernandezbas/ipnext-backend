import { ScheduledTask, TaskStatus } from '../entities/scheduling';

export interface SchedulingRepository {
  listTasks(): Promise<ScheduledTask[]>;
  getTask(id: string): Promise<ScheduledTask | null>;
  createTask(data: Omit<ScheduledTask, 'id'>): Promise<ScheduledTask>;
  updateTask(id: string, data: Partial<ScheduledTask>): Promise<ScheduledTask | null>;
  deleteTask(id: string): Promise<boolean>;
  updateTaskStatus(id: string, status: TaskStatus): Promise<ScheduledTask | null>;
}

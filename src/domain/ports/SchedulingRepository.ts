import { ScheduledTask, TaskStatus } from '../entities/scheduling';

export interface SchedulingRepository {
  listTasks(): Promise<ScheduledTask[]>;
  getTask(id: string): Promise<ScheduledTask | null>;
  createTask(data: Omit<ScheduledTask, 'id' | 'sequenceNumber' | 'stageCategory' | 'status'>): Promise<ScheduledTask>;
  updateTask(id: string, data: Partial<ScheduledTask>): Promise<ScheduledTask | null>;
  deleteTask(id: string): Promise<boolean>;
  moveTaskToStage(id: string, stageId: string): Promise<ScheduledTask | null>;
  /** @deprecated use moveTaskToStage */
  updateTaskStatus(id: string, status: TaskStatus): Promise<ScheduledTask | null>;
}

import { ScheduledTask, TaskStatus } from '../entities/scheduling';

export interface CreateTaskInput extends Omit<ScheduledTask,
  'id' | 'sequenceNumber' | 'stageCategory' | 'status' | 'customerName' | 'assigneeName' | 'watcherIds'
> {
  watcherIds?: string[];
}

export interface UpdateTaskInput extends Partial<CreateTaskInput> {}

export interface SchedulingRepository {
  listTasks(): Promise<ScheduledTask[]>;
  getTask(id: string): Promise<ScheduledTask | null>;
  createTask(data: CreateTaskInput): Promise<ScheduledTask>;
  updateTask(id: string, data: UpdateTaskInput): Promise<ScheduledTask | null>;
  deleteTask(id: string): Promise<boolean>;
  moveTaskToStage(id: string, stageId: string): Promise<ScheduledTask | null>;
  /** @deprecated use moveTaskToStage */
  updateTaskStatus(id: string, status: TaskStatus): Promise<ScheduledTask | null>;
}

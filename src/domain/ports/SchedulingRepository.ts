import { ScheduledTask } from '../entities/scheduling';
import { TaskChecklistItem } from '../entities/checklist';
import { TaskListFilter } from '@application/dto/scheduling.dto';

export interface CreateTaskInput extends Omit<ScheduledTask,
  'id' | 'sequenceNumber' | 'stageCategory' | 'customerName' | 'customerCity' | 'assigneeName' | 'watcherIds' | 'createdAt' | 'updatedAt'
> {
  watcherIds?: string[];
}

export interface UpdateTaskInput extends Partial<CreateTaskInput> {}

export interface SchedulingRepository {
  listTasks(filter?: TaskListFilter): Promise<ScheduledTask[]>;
  getTask(id: string): Promise<ScheduledTask | null>;
  createTask(data: CreateTaskInput): Promise<ScheduledTask>;
  updateTask(id: string, data: UpdateTaskInput): Promise<ScheduledTask | null>;
  deleteTask(id: string): Promise<boolean>;
  moveTaskToStage(id: string, stageId: string): Promise<ScheduledTask | null>;

  // Checklist methods (change 5)
  getTaskWithChecklist(id: string): Promise<(ScheduledTask & { checklist: TaskChecklistItem[] }) | null>;
  addChecklistItem(taskId: string, text: string): Promise<TaskChecklistItem>;
  toggleChecklistItem(itemId: string): Promise<TaskChecklistItem>;
  updateChecklistItem(itemId: string, text: string): Promise<TaskChecklistItem>;
  removeChecklistItem(itemId: string): Promise<boolean>;
  reorderChecklistItems(taskId: string, orderedIds: string[]): Promise<TaskChecklistItem[]>;
  assignTemplateToTask(taskId: string, templateId: string): Promise<TaskChecklistItem[]>;
  clearChecklist(taskId: string): Promise<void>;
}

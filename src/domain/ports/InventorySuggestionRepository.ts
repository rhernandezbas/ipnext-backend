import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';

export interface InventorySuggestionRepository {
  listByTask(taskId: string): Promise<TaskInventorySuggestion[]>;
  /**
   * Insert or update by natural key (taskId + kind + serialNumber|mac|materialDesc)
   * so re-ingesting the same closure does not duplicate suggestions.
   */
  upsert(suggestion: TaskInventorySuggestion): Promise<TaskInventorySuggestion>;
  get(id: string): Promise<TaskInventorySuggestion | null>;
  setStatus(
    id: string,
    status: TaskInventorySuggestion['status'],
    confirmedItemId?: string,
  ): Promise<TaskInventorySuggestion | null>;
}

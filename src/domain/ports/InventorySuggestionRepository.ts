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
    /** When provided, persists the operator's chosen device type onto the
     * suggestion so the resolved view reflects what was confirmed, not the scan. */
    deviceType?: string,
  ): Promise<TaskInventorySuggestion | null>;
  /** #14: true if the task has ≥1 DEVICE suggestion not discarded (materials don't count). */
  hasDeviceForTask(taskId: string): Promise<boolean>;
}

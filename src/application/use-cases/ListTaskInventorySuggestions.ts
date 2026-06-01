import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';

/** Lists the staged inventory suggestions of a task (the operator's checkboxes). */
export class ListTaskInventorySuggestions {
  constructor(private readonly suggestions: InventorySuggestionRepository) {}

  execute(taskId: string): Promise<TaskInventorySuggestion[]> {
    return this.suggestions.listByTask(taskId);
  }
}

import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import { SuggestionNotFoundError } from '@domain/errors/inventory';

/** Marks a staged suggestion as discarded (operator dismissed it). */
export class DiscardInventorySuggestion {
  constructor(private readonly suggestions: InventorySuggestionRepository) {}

  async execute(suggestionId: string): Promise<TaskInventorySuggestion> {
    const updated = await this.suggestions.setStatus(suggestionId, 'discarded');
    if (!updated) throw new SuggestionNotFoundError(suggestionId);
    return updated;
  }
}

import { ReturnSuggestionRepository } from '@domain/ports/ReturnSuggestionRepository';

/**
 * FIX C wire contract — minimal view for the task-detail panel.
 * All status values from the ReturnSuggestion entity:
 * 'pending' | 'needs_review' | 'confirmed' | 'discarded'
 */
export interface ReturnSuggestionByTaskDto {
  id: string;
  status: string;
  resolution: string | null;
  serialNumber: string | null;
  createdAt: string;
}

/**
 * Returns all return suggestions for a task (any status). Empty array when none.
 * Used by the task-detail panel to show which equipment returns were staged.
 */
export class ListReturnSuggestionsByTask {
  constructor(private readonly returns: ReturnSuggestionRepository) {}

  async execute(taskId: string): Promise<ReturnSuggestionByTaskDto[]> {
    const suggestions = await this.returns.listByTask(taskId);
    return suggestions.map((s) => ({
      id: s.id,
      status: s.status,
      resolution: s.resolution,
      serialNumber: s.serialNumber,
      createdAt: s.createdAt,
    }));
  }
}

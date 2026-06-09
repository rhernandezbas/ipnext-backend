import { ReturnSuggestionRepository } from '@domain/ports/ReturnSuggestionRepository';
import { ReturnSuggestionDto, toReturnSuggestionDto } from '@application/dto/ReturnSuggestionDto';

/**
 * Read-only list of return suggestions awaiting an operator decision (EPIC #38 W4):
 * `pending` (matched) + `needs_review` (no match). DTOs only — never raw entities.
 */
export class ListPendingReturns {
  constructor(private readonly returns: ReturnSuggestionRepository) {}

  async execute(): Promise<ReturnSuggestionDto[]> {
    const rows = await this.returns.listPending();
    return rows.map(toReturnSuggestionDto);
  }
}

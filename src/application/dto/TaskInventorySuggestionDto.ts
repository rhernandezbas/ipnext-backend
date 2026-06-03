import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';

export type MatchStatus = 'same_device' | 'same_type';

export interface SuggestionMatch {
  status: MatchStatus;
  /** id of the ContractInstalledItem that matched. */
  itemId: string;
  /** Serial number of the matched item (for the badge). */
  serial: string | null;
}

export interface TaskInventorySuggestionDto extends TaskInventorySuggestion {
  /** Cross-check against the contract's active inventory. null = no match. */
  match: SuggestionMatch | null;
}

export function toTaskInventorySuggestionDto(
  s: TaskInventorySuggestion,
  match: SuggestionMatch | null,
): TaskInventorySuggestionDto {
  return { ...s, match };
}

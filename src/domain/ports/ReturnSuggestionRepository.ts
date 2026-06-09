import {
  ReturnSuggestion,
  ReturnSuggestionStatus,
  ReturnResolution,
} from '@domain/entities/return-suggestion';

/** Patch applied when an operator resolves a suggestion (confirm/link/create/discard). */
export interface SetReturnSuggestionStatusInput {
  status: ReturnSuggestionStatus;
  resolution?: ReturnResolution | null;
  /** The real movement.id (uuid) produced on confirm (Fix #5). */
  confirmedMovementId?: string | null;
  /** L2 natural key `iclass:return:{assetId}` — the findBySourceRef key (Fix #3/#5). */
  sourceRef?: string | null;
  matchedAssetId?: string | null;
}

/**
 * Persistence for closure-detected return suggestions (EPIC #38 W4).
 *
 * `create` upserts by the natural key (serviceOrderId, serialNumber) so a
 * partial-crash re-stage silently dedups (REQ — Staging Idempotency / @@unique).
 */
export interface ReturnSuggestionRepository {
  /**
   * Stage a suggestion. Idempotent by (serviceOrderId, serialNumber): if a row for
   * that pair already exists, it is returned unchanged (no duplicate, no overwrite).
   */
  create(suggestion: ReturnSuggestion): Promise<ReturnSuggestion>;
  get(id: string): Promise<ReturnSuggestion | null>;
  /** Operator surface: suggestions awaiting action (`pending` + `needs_review`). */
  listPending(): Promise<ReturnSuggestion[]>;
  listByTask(taskId: string): Promise<ReturnSuggestion[]>;
  /** Stamp a new status (+ resolution/movement/match) on an existing suggestion. */
  setStatus(id: string, patch: SetReturnSuggestionStatusInput): Promise<ReturnSuggestion | null>;
  /** L2 idempotency lookup — a suggestion already linked to this confirmed movement. */
  findBySourceRef(sourceRef: string): Promise<ReturnSuggestion | null>;
}

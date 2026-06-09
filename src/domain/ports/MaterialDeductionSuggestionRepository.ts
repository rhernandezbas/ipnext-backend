import {
  MaterialDeductionSuggestion,
  MaterialDeductionStatus,
  MaterialDeductionResolution,
} from '@domain/entities/material-deduction-suggestion';

/** Patch applied when an operator confirms or discards a suggestion. */
export interface UpdateMaterialDeductionSuggestionInput {
  status: MaterialDeductionStatus;
  resolution?: MaterialDeductionResolution | null;
  sourceRef?: string | null;
  deductedMovementId?: string | null;
}

/**
 * Persistence for material deduction suggestions (EPIC #38 W6).
 *
 * `create` is L1-idempotent by `taskMaterialConsumptionId` UNIQUE: a re-stage
 * (partial-crash retry) returns the existing row unchanged — one consumption =
 * at most one suggestion.
 */
export interface MaterialDeductionSuggestionRepository {
  /**
   * Stage a suggestion. Idempotent by taskMaterialConsumptionId: if a row for that
   * consumption already exists, it is returned unchanged (no duplicate, no overwrite).
   */
  create(suggestion: MaterialDeductionSuggestion): Promise<MaterialDeductionSuggestion>;

  /** Retrieve a suggestion by its id. */
  findById(id: string): Promise<MaterialDeductionSuggestion | null>;

  /** L1 idempotency lookup — a suggestion already staged for this consumption. */
  findByConsumptionId(consumptionId: string): Promise<MaterialDeductionSuggestion | null>;

  /** Operator surface: suggestions awaiting action (`pending` + `needs_review`). */
  listPending(): Promise<MaterialDeductionSuggestion[]>;

  /** L2 idempotency lookup — a suggestion already linked to this sourceRef. */
  findBySourceRef(sourceRef: string): Promise<MaterialDeductionSuggestion | null>;

  /** Stamp a new status (+ resolution/sourceRef/movementId) on an existing suggestion. */
  updateStatus(
    id: string,
    patch: UpdateMaterialDeductionSuggestionInput,
  ): Promise<MaterialDeductionSuggestion | null>;
}

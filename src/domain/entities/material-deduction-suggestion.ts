import { roundQty } from './material-stock';

/**
 * Material deduction suggestion (EPIC #38 W6).
 *
 * Staged (read-only, flag-gated) when a TaskMaterialConsumption is created via
 * RecordMaterialConsumption OR ConfirmInventorySuggestion.handleMaterial. An
 * operator later confirms (the ONLY stock mutation) via ConfirmMaterialDeduction
 * which records a CONSUME movement from the technician's TECNICO location.
 *
 * Mirrors ReturnSuggestion (W4): stage→confirm pattern, same L1/L2 idempotency.
 */

export type MaterialDeductionStatus = 'pending' | 'needs_review' | 'confirmed' | 'discarded';
export type MaterialDeductionResolution = 'deduct' | 'issue-first' | 'depot' | 'discard';

export interface MaterialDeductionSuggestion {
  id: string;
  /** L1 unique: one consumption → at most one suggestion. */
  taskMaterialConsumptionId: string;
  taskId: string;
  /** null when the task had no assignee at stage time → always needs_review. */
  technicianId: string | null;
  materialCatalogId: string;
  qty: number;
  /** null when no TECNICO location could be resolved → always needs_review. */
  technicianLocationId: string | null;
  status: MaterialDeductionStatus;
  /** Set on confirm; null while pending/needs_review. */
  resolution: MaterialDeductionResolution | null;
  /** L2 natural key: `consume:task-material:{consumptionId}` — stamped on confirm. */
  sourceRef: string | null;
  /** The InventoryMovement.id produced on confirm. */
  deductedMovementId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMaterialDeductionSuggestionInput {
  id: string;
  taskMaterialConsumptionId: string;
  taskId: string;
  technicianId?: string | null;
  materialCatalogId: string;
  qty: number;
  technicianLocationId?: string | null;
  /** Defaults to 'pending'. Caller passes 'needs_review' when stock/assignee is insufficient. */
  status?: MaterialDeductionStatus;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Factory with staging defaults. `status` defaults to 'pending'; staging use case
 * passes 'needs_review' explicitly when stock < qty or no assignee.
 *
 * qty is ALWAYS routed through `roundQty` (the W1 single-rounding rule) so
 * in-memory and Prisma (Decimal(12,4)) land bit-identical values.
 */
export function createMaterialDeductionSuggestion(
  input: CreateMaterialDeductionSuggestionInput,
): MaterialDeductionSuggestion {
  const now = new Date().toISOString();
  return {
    id: input.id,
    taskMaterialConsumptionId: input.taskMaterialConsumptionId,
    taskId: input.taskId,
    technicianId: input.technicianId ?? null,
    materialCatalogId: input.materialCatalogId,
    qty: roundQty(input.qty),
    technicianLocationId: input.technicianLocationId ?? null,
    status: input.status ?? 'pending',
    resolution: null,
    sourceRef: null,
    deductedMovementId: null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

/** L2 natural key for the CONSUME movement sourceRef. */
export function deductionSourceRef(consumptionId: string): string {
  return `consume:task-material:${consumptionId}`;
}

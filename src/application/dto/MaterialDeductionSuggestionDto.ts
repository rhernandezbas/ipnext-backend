import { MaterialDeductionSuggestion } from '@domain/entities/material-deduction-suggestion';

/**
 * Operator-facing view of a material deduction suggestion (EPIC #38 W6).
 *
 * FIX 6: enriched to match the FE contract (`DeductionSuggestion` in
 * `ipnext-frontend/src/types/deductions.ts`). Field names map 1-to-1:
 *   consumptionId  ← taskMaterialConsumptionId
 *   materialId     ← materialCatalogId
 *   materialName   ← resolved via MaterialCatalogRepository
 *   materialUnit   ← resolved via MaterialCatalogRepository
 *   technicianName ← resolved via RbacUserRepository (technicianId → name)
 *   taskSeq        ← resolved via SchedulingRepository (task.sequenceNumber)
 *   taskTitle      ← resolved via SchedulingRepository (task.title)
 */
export interface MaterialDeductionSuggestionDto {
  id: string;
  /** FE: consumptionId */
  consumptionId: string;
  taskId: string | null;
  taskSeq: number | null;
  taskTitle: string | null;
  /** FE: materialId */
  materialId: string;
  materialName: string;
  materialUnit: string | null;
  qty: number;
  technicianId: string | null;
  technicianName: string | null;
  status: string;
  resolution: string | null;
  createdAt: string;
}

/**
 * Basic (non-enriched) mapper — used internally; callers should prefer
 * `toEnrichedDto` for the operator-facing list. Confirm/discard routes
 * may return this shape since the FE refetches the list on mutation.
 */
export function toMaterialDeductionSuggestionDto(
  s: MaterialDeductionSuggestion,
  materialName = '',
  materialUnit: string | null = null,
  technicianName: string | null = null,
  taskSeq: number | null = null,
  taskTitle: string | null = null,
): MaterialDeductionSuggestionDto {
  return {
    id: s.id,
    consumptionId: s.taskMaterialConsumptionId,
    taskId: s.taskId ?? null,
    taskSeq,
    taskTitle,
    materialId: s.materialCatalogId,
    materialName,
    materialUnit,
    qty: s.qty,
    technicianId: s.technicianId,
    technicianName,
    status: s.status,
    resolution: s.resolution,
    createdAt: s.createdAt,
  };
}

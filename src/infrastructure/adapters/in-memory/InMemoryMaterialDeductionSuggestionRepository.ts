import {
  MaterialDeductionSuggestionRepository,
  UpdateMaterialDeductionSuggestionInput,
} from '@domain/ports/MaterialDeductionSuggestionRepository';
import { MaterialDeductionSuggestion } from '@domain/entities/material-deduction-suggestion';

/**
 * In-memory MaterialDeductionSuggestion store (EPIC #38 W6 tests).
 *
 * `create` honors the UNIQUE(taskMaterialConsumptionId): a re-stage of the same
 * consumptionId returns the existing row unchanged (silent L1 dedup), so a
 * partial-crash re-run never duplicates.
 */
export class InMemoryMaterialDeductionSuggestionRepository
  implements MaterialDeductionSuggestionRepository
{
  readonly store = new Map<string, MaterialDeductionSuggestion>();

  async create(suggestion: MaterialDeductionSuggestion): Promise<MaterialDeductionSuggestion> {
    // L1 dedup: if a suggestion for this consumptionId already exists, return it unchanged.
    const existing = Array.from(this.store.values()).find(
      (s) => s.taskMaterialConsumptionId === suggestion.taskMaterialConsumptionId,
    );
    if (existing) return { ...existing };
    this.store.set(suggestion.id, { ...suggestion });
    return { ...suggestion };
  }

  async findById(id: string): Promise<MaterialDeductionSuggestion | null> {
    const s = this.store.get(id);
    return s ? { ...s } : null;
  }

  async findByConsumptionId(consumptionId: string): Promise<MaterialDeductionSuggestion | null> {
    const s = Array.from(this.store.values()).find(
      (x) => x.taskMaterialConsumptionId === consumptionId,
    );
    return s ? { ...s } : null;
  }

  async listPending(): Promise<MaterialDeductionSuggestion[]> {
    return Array.from(this.store.values())
      .filter((s) => s.status === 'pending' || s.status === 'needs_review')
      .map((s) => ({ ...s }));
  }

  async findBySourceRef(sourceRef: string): Promise<MaterialDeductionSuggestion | null> {
    const s = Array.from(this.store.values()).find((x) => x.sourceRef === sourceRef);
    return s ? { ...s } : null;
  }

  async updateStatus(
    id: string,
    patch: UpdateMaterialDeductionSuggestionInput,
  ): Promise<MaterialDeductionSuggestion | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    // Fix 4: terminal-state guard. Once a suggestion is confirmed or discarded it
    // cannot be transitioned again. Any attempt returns null (0 rows affected
    // semantics — same as the Prisma updateMany guard). The L1 guard in
    // ConfirmMaterialDeduction.execute catches the common re-click; this guard
    // covers the concurrent race path where two operations read 'pending' and then
    // both call updateStatus simultaneously.
    if (existing.status === 'confirmed' || existing.status === 'discarded') {
      return null;
    }
    const updated: MaterialDeductionSuggestion = {
      ...existing,
      status: patch.status,
      resolution: patch.resolution !== undefined ? patch.resolution : existing.resolution,
      sourceRef: patch.sourceRef !== undefined ? patch.sourceRef : existing.sourceRef,
      deductedMovementId:
        patch.deductedMovementId !== undefined
          ? patch.deductedMovementId
          : existing.deductedMovementId,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return { ...updated };
  }
}

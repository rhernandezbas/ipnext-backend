import {
  ReturnSuggestionRepository,
  SetReturnSuggestionStatusInput,
} from '@domain/ports/ReturnSuggestionRepository';
import { ReturnSuggestion } from '@domain/entities/return-suggestion';

/**
 * In-memory ReturnSuggestion store (EPIC #38 W4 tests).
 *
 * `create` mirrors the Prisma `@@unique([serviceOrderId, serialNumber])`: a re-stage
 * of the same pair returns the existing row unchanged (silent dedup), so a partial-crash
 * re-run never duplicates. confirmedMovementId is the L2 sourceRef lookup key for
 * findBySourceRef (the use case stamps it on confirm).
 */
export class InMemoryReturnSuggestionRepository implements ReturnSuggestionRepository {
  readonly store = new Map<string, ReturnSuggestion>();

  private naturalKey(serviceOrderId: string, serialNumber: string | null): string {
    return `${serviceOrderId}::${serialNumber ?? '∅'}`;
  }

  async create(suggestion: ReturnSuggestion): Promise<ReturnSuggestion> {
    const key = this.naturalKey(suggestion.serviceOrderId, suggestion.serialNumber);
    const existing = Array.from(this.store.values()).find(
      (s) => this.naturalKey(s.serviceOrderId, s.serialNumber) === key,
    );
    if (existing) return { ...existing };
    this.store.set(suggestion.id, { ...suggestion });
    return { ...suggestion };
  }

  async get(id: string): Promise<ReturnSuggestion | null> {
    const s = this.store.get(id);
    return s ? { ...s } : null;
  }

  async listPending(): Promise<ReturnSuggestion[]> {
    return Array.from(this.store.values())
      .filter((s) => s.status === 'pending' || s.status === 'needs_review')
      .map((s) => ({ ...s }));
  }

  async listByTask(taskId: string): Promise<ReturnSuggestion[]> {
    return Array.from(this.store.values())
      .filter((s) => s.taskId === taskId)
      .map((s) => ({ ...s }));
  }

  async setStatus(id: string, patch: SetReturnSuggestionStatusInput): Promise<ReturnSuggestion | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated: ReturnSuggestion = {
      ...existing,
      status: patch.status,
      resolution: patch.resolution !== undefined ? patch.resolution : existing.resolution,
      confirmedMovementId:
        patch.confirmedMovementId !== undefined ? patch.confirmedMovementId : existing.confirmedMovementId,
      sourceRef: patch.sourceRef !== undefined ? patch.sourceRef : existing.sourceRef,
      matchedAssetId: patch.matchedAssetId !== undefined ? patch.matchedAssetId : existing.matchedAssetId,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return { ...updated };
  }

  async findBySourceRef(sourceRef: string): Promise<ReturnSuggestion | null> {
    // Fix #5: keys on the dedicated sourceRef field (confirmedMovementId now holds the uuid).
    const s = Array.from(this.store.values()).find((x) => x.sourceRef === sourceRef);
    return s ? { ...s } : null;
  }
}

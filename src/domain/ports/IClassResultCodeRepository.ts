import { IClassResultCode } from '@domain/entities/iclass-result-code';

export interface UpsertResultCodeInput {
  soTypeId: string | null;
  code: string;
  type: string;
}

/**
 * Persistence for the IClass result-code catalog + its configurable closure
 * mapping (result code → target Stage). Mirrors IClassSoTypeRepository in shape.
 */
export interface IClassResultCodeRepository {
  list(filter?: { mapped?: boolean }): Promise<IClassResultCode[]>;
  getById(id: string): Promise<IClassResultCode | null>;
  /**
   * Resolve a result code by its name (motivoFechamento) for the closure join.
   * Returns the first match (motivoFechamento carries no SO-type id in the SO
   * payload, so the lookup is by name). Null when not catalogued.
   */
  findByCode(code: string): Promise<IClassResultCode | null>;
  /** Upsert one entry keyed by (soTypeId, code) during the catalog sync. */
  upsert(entry: UpsertResultCodeInput): Promise<{ status: 'created' | 'updated' }>;
  /**
   * Set (or clear, with null) the target Stage for a result code — the
   * configurable closure mapping assigned from the admin UX. Returns the updated
   * entry, or null when the id does not exist.
   */
  assignStage(id: string, stageId: string | null): Promise<IClassResultCode | null>;
}

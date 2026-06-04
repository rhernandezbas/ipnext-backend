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
   * Returns the first match, case-insensitive + trimmed. Null when not catalogued.
   * Used as the fallback when the SO has no soTypeId.
   */
  findByCode(code: string): Promise<IClassResultCode | null>;
  /**
   * Resolve a result code by (soTypeId, code), case-insensitive + trimmed. The same
   * code maps to different stages across SO types (e.g. "Posponer por falta de
   * material" → Sin_material for most types but Pospuesta for one), so the closure
   * join MUST disambiguate by the SO's type. Null when no entry for that pair.
   */
  findBySoTypeAndCode(soTypeId: string, code: string): Promise<IClassResultCode | null>;
  /** Upsert one entry keyed by (soTypeId, code) during the catalog sync. */
  upsert(entry: UpsertResultCodeInput): Promise<{ status: 'created' | 'updated' }>;
  /**
   * Set (or clear, with null) the target Stage for a result code — the
   * configurable closure mapping assigned from the admin UX. Returns the updated
   * entry, or null when the id does not exist.
   */
  assignStage(id: string, stageId: string | null): Promise<IClassResultCode | null>;
}

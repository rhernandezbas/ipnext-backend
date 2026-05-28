/**
 * Catalog entry for an IClass Service Order type.
 * `code` is the value IClass accepts as `typeSOSummary` in the OS payload.
 * `id` (UUID) is the FK stored on Project — more stable than `code` against renames.
 */
export interface IClassSoType {
  id: string;
  code: string;         // trimmed `codigo` from IClass — unique
  description: string;  // trimmed `descricao`
  active: boolean;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

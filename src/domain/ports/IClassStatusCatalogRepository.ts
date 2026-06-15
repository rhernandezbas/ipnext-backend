import { IClassStatusCatalogEntry } from '@domain/entities/iclass-status-catalog';

export interface UpsertStatusInput {
  statusCode: string;
  iclassLabel: string;
}

export interface UpdateStatusInput {
  displayLabel?: string | null;
  color?: string | null;
  tracked?: boolean;
  /**
   * iclass-intermediate-states — FK to a Prominense Stage. Set to map this IClass status
   * to a kanban column (auto-move on status change); null clears the mapping. Omitted → preserve.
   */
  prominenseStageId?: string | null;
}

/**
 * Persistence for the IClass status catalog (auto-discovery + editable config).
 * The upsert preserves operator-configured fields (displayLabel, color, tracked).
 * The update only touches the provided fields (partial patch).
 */
export interface IClassStatusCatalogRepository {
  /** List all entries ordered by statusCode. */
  list(): Promise<IClassStatusCatalogEntry[]>;

  /** Find an entry by its statusCode. Null when not found. */
  getByStatusCode(statusCode: string): Promise<IClassStatusCatalogEntry | null>;

  /**
   * Upsert by statusCode:
   * - New entry: created with tracked=false, displayLabel=null, color=null, prominenseStageId=null.
   * - Existing entry: refreshes iclassLabel + lastSyncedAt; PRESERVES displayLabel/color/tracked/prominenseStageId.
   * Returns whether the entry was created or updated.
   */
  upsertByStatusCode(input: UpsertStatusInput): Promise<{ status: 'created' | 'updated' }>;

  /**
   * Partially update the operator-configurable fields (displayLabel, color, tracked).
   * Returns the updated entry, or null when the statusCode does not exist.
   */
  update(statusCode: string, patch: UpdateStatusInput): Promise<IClassStatusCatalogEntry | null>;

  /**
   * Batch lookup for the read-path (task list/detail): resolve multiple entries by statusCode
   * in a single query to avoid N+1. Returns only the entries that exist; missing codes are silently omitted.
   */
  findManyByStatusCodes(codes: string[]): Promise<IClassStatusCatalogEntry[]>;
}

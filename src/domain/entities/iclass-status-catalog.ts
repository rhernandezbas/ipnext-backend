/**
 * Catalog entry for an IClass OS STATUS CODE (status.id / status.descricao).
 *
 * Auto-discovered from the service-order status field on each ingest tick.
 * Operators can configure displayLabel, color, and tracked (opt-in visibility).
 *
 * The `effectiveLabel` is a DERIVED read helper:
 *   displayLabel ?? iclassLabel
 * It is NOT stored — it is computed at query time (or by a DTO mapper).
 */
export interface IClassStatusCatalogEntry {
  id: string;
  /** Opaque IClass status id (e.g. "7", "3", "50"). UNIQUE. */
  statusCode: string;
  /** Raw status.descricao from IClass — refreshed on every upsert. */
  iclassLabel: string;
  /** Prominense-editable label. NULL → use iclassLabel (effectiveLabel). */
  displayLabel: string | null;
  /** Hex color for the badge (e.g. "#FF5500"). NULL → no color. */
  color: string | null;
  /** Opt-in flag: whether this status is visible in the FE. Default false. */
  tracked: boolean;
  /** Last time this entry was seen/synced from IClass. */
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Derived helper — not stored, computed by the read-path or DTO mapper. */
export function effectiveLabel(entry: Pick<IClassStatusCatalogEntry, 'displayLabel' | 'iclassLabel'>): string {
  return entry.displayLabel ?? entry.iclassLabel;
}

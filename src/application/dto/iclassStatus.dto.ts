import { IClassStatusCatalogEntry, effectiveLabel } from '@domain/entities/iclass-status-catalog';
import { z } from 'zod';

/** API wire shape for a single IClass status catalog entry. */
export interface IClassStatusCatalogDTO {
  statusCode: string;
  iclassLabel: string;
  /** Prominense-editable label. Null when not set. */
  displayLabel: string | null;
  /** Computed: displayLabel ?? iclassLabel */
  effectiveLabel: string;
  /** Hex color for badge. Null when not configured. */
  color: string | null;
  tracked: boolean;
  lastSyncedAt: string; // ISO 8601
}

/** Maps an entity to the API DTO. */
export function toStatusCatalogDTO(entry: IClassStatusCatalogEntry): IClassStatusCatalogDTO {
  return {
    statusCode: entry.statusCode,
    iclassLabel: entry.iclassLabel,
    displayLabel: entry.displayLabel,
    effectiveLabel: effectiveLabel(entry),
    color: entry.color,
    tracked: entry.tracked,
    lastSyncedAt: entry.lastSyncedAt instanceof Date
      ? entry.lastSyncedAt.toISOString()
      : entry.lastSyncedAt,
  };
}

/** Zod schema for PATCH /statuses/:statusCode — all fields optional (partial patch). */
export const UpdateStatusSchema = z.object({
  displayLabel: z.string().nullable().optional(),
  /** Hex color #RRGGBB. Null clears the color. */
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  tracked: z.boolean().optional(),
});

export type UpdateStatusInput = z.infer<typeof UpdateStatusSchema>;

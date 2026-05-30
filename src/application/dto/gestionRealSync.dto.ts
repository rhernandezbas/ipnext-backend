import { z } from 'zod';
import { SyncConfig } from '@domain/ports/GestionRealSyncConfigRepository';

// ── Config DTO ─────────────────────────────────────────────────────────────

/**
 * Outbound config DTO. Shape-identical to the domain `SyncConfig`, but kept as a
 * distinct type so routes/use-cases never leak a Prisma entity (`id`/`updatedAt`
 * / the comma-joined string) and so the wire contract can evolve independently.
 */
export interface SyncConfigDTO {
  intervalMs: number;
  estados: string[];
}

export function toSyncConfigDTO(config: SyncConfig): SyncConfigDTO {
  return {
    intervalMs: config.intervalMs,
    estados: [...config.estados],
  };
}

// ── Update Config input validation (REQ-PUTCFG-2) ───────────────────────────

/**
 * Allowed GR estado codes: 1=Activo, 2=Deudor, 3=Inactivo, 4=Incobrable, 6=Baja.
 * `5` is intentionally excluded (matches the GR_SYNC_ESTADOS env default).
 */
export const ALLOWED_ESTADOS = ['1', '2', '3', '4', '6'] as const;

/**
 * Inbound PUT body. Every field optional (partial update). `intervalMs` must be a
 * positive integer; `estados` must be an array of whitelisted codes. A bad shape
 * (e.g. `intervalMs: "soon"`) fails with a Zod error the route maps to 400.
 */
export const UpdateSyncConfigSchema = z
  .object({
    intervalMs: z.number().int().positive(),
    estados: z.array(z.enum(ALLOWED_ESTADOS)),
  })
  .partial();

export type UpdateSyncConfigInput = z.infer<typeof UpdateSyncConfigSchema>;

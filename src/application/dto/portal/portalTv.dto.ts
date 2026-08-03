import { z } from 'zod';

/**
 * EPIC v3 (clave de TV del portal) — `GET /api/portal/tv/:contractId`.
 * Contrato PÚBLICO (apps instaladas): solo agregar campos, jamás tocar estos.
 * `hasTv:false` es un estado NORMAL (200), mismo criterio que la elegibilidad
 * WiFi. NUNCA viaja la password por este DTO — solo el login (GIGA{abonado}).
 */
export interface PortalTvStatusDto {
  hasTv: boolean;
  login: string | null;
}

/**
 * Fix wave S1 — `PUT /api/portal/tv/:contractId/password`. Schema `.strict()`
 * como los hermanos (wifi.dto.ts): campo extra -> 400 VALIDATION_ERROR — que
 * un body con `cic` u otra sorpresa NUNCA pase en silencio. Validación de
 * FORMA solamente; la política CUA ([a-z0-9] 8..64) corre en el use case.
 */
export const ChangePortalTvPasswordSchema = z
  .object({
    password: z.string().min(1),
  })
  .strict();

export type ChangePortalTvPasswordBody = z.infer<typeof ChangePortalTvPasswordSchema>;

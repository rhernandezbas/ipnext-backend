/**
 * pppoe.dto.ts — DTO de lectura + schemas Zod de body para el módulo PPPoE.
 *
 * Decisiones:
 *  - PppoeServiceDto NO expone `password` (Decisión 3 del design: la clave PPPoE
 *    es write-only; nunca viaja al browser).
 *  - `nasName` se incluye en el DTO para que la UI mueda mostrar el nombre sin
 *    join en el cliente. El valor es opcional (puede ser null si el NAS se borró).
 */
import { z } from 'zod';

// ── DTO de respuesta ─────────────────────────────────────────────────────────

export interface PppoeServiceDto {
  id: string;
  username: string;
  profile: string | null;
  remoteAddress: string | null;
  status: string;
  nasId: string;
  contractId: string | null;
  createdAt: string;
}

/**
 * Mapea la entidad de dominio `PppoeService` al DTO de respuesta.
 * Omite `password` intencionalmente — es la frontera de seguridad.
 */
export function toPppoeServiceDto(s: {
  id: string;
  username: string;
  profile: string | null;
  remoteAddress: string | null;
  status: string;
  nasId: string;
  contractId: string | null;
  createdAt: string;
}): PppoeServiceDto {
  return {
    id:            s.id,
    username:      s.username,
    profile:       s.profile,
    remoteAddress: s.remoteAddress,
    status:        s.status,
    nasId:         s.nasId,
    contractId:    s.contractId,
    createdAt:     s.createdAt,
  };
}

// ── Body schemas (Zod) ──────────────────────────────────────────────────────

export const CreatePppoeBodySchema = z.object({
  username:      z.string().min(1),
  password:      z.string().min(1),
  nasId:         z.string().min(1),
  profile:       z.string().nullable().optional(),
  remoteAddress: z.string().nullable().optional(),
});

export type CreatePppoeBody = z.infer<typeof CreatePppoeBodySchema>;

export const UpdatePppoeBodySchema = z.object({
  profile:       z.string().nullable().optional(),
  password:      z.string().min(1).optional(),
  remoteAddress: z.string().nullable().optional(),
  status:        z.enum(['enabled', 'disabled']).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided' },
);

export type UpdatePppoeBody = z.infer<typeof UpdatePppoeBodySchema>;

export const MovePppoeBodySchema = z.object({
  nasId: z.string().min(1),
});

export type MovePppoeBody = z.infer<typeof MovePppoeBodySchema>;

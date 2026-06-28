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
  enforcedState: string; // Fase C — active | reduced | blocked
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
  enforcedState: string;
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
    enforcedState: s.enforcedState,
    nasId:         s.nasId,
    contractId:    s.contractId,
    createdAt:     s.createdAt,
  };
}

// ── PppoeAssignmentDto — Asignaciones tab (Bug 3) ────────────────────────────

/**
 * DTO de la tab Asignaciones. Wire contract BE↔FE (campo por campo, NO cambiar sin sync FE).
 * `ip` = remoteAddress (alias para la UI de redes).
 * `password` NUNCA incluida — frontera de seguridad.
 */
export interface PppoeAssignmentDto {
  id: string;
  ip: string;          // = remoteAddress (siempre non-null: filterado por findAssigned)
  username: string;
  contractId: string;  // siempre non-null: filterado por findAssigned
  profile: string | null;
  nasId: string;
  status: string;
  createdAt: string;
}

export function toPppoeAssignmentDto(s: {
  id: string;
  remoteAddress: string;
  username: string;
  contractId: string;
  profile: string | null;
  nasId: string;
  status: string;
  createdAt: string;
}): PppoeAssignmentDto {
  return {
    id:         s.id,
    ip:         s.remoteAddress,
    username:   s.username,
    contractId: s.contractId,
    profile:    s.profile,
    nasId:      s.nasId,
    status:     s.status,
    createdAt:  s.createdAt,
  };
}

// ── internet-history — vista GLOBAL de servicios de internet (espejo de TV) ──

/**
 * DTO de un item de la lista GLOBAL de servicios de internet (GET /api/pppoe).
 * Curado para la página espejo de TV: cruza al cliente (clientId/customerName) y expone
 * quién creó el servicio (createdBy = actorName del evento 'activated' de internet, si está).
 * NUNCA expone `password` — frontera de seguridad (igual que PppoeServiceDto).
 */
export interface PppoeServiceListItemDto {
  id: string;
  username: string;
  profile: string | null;
  /**
   * Estado de NEGOCIO computado (NO el crudo de RADIUS): 'active' | 'reduced' | 'blocked' | 'baja' | 'inactive'.
   * Computed via pppoeDisplayStatus(status, enforcedState). Wire contract acordado con el FE.
   */
  status: string;
  /** enforcedState crudo (active|reduced|blocked) — el FE NO lo usa; queda por compatibilidad/diagnóstico. */
  enforcedState: string;
  nasId: string;
  contractId: string | null;
  clientId: string | null;
  customerName: string | null;
  /** actorName del evento 'activated' del servicio de internet de ese contrato (best-effort, null si no se registró). */
  createdBy: string | null;
  createdAt: string;
}

/** DTO paginado de la lista GLOBAL de servicios de internet. */
export interface PppoeServiceListPageDto {
  data: PppoeServiceListItemDto[];
  total: number;
  page: number;
  limit: number;
}

/**
 * #internet-history — Evento del historial GLOBAL de servicios de INTERNET (wire contract).
 * Espejo de TvActivationEventDto: mismo shape de cruce-a-cliente + actor + reason.
 * Devuelto por ListInternetServiceHistory. NUNCA contiene password.
 */
export interface InternetServiceEventDto {
  id: string;
  contractId: string;
  clientId: string | null;
  customerName: string | null;
  serviceCatalogId: string;
  eventType: string; // activated | deactivated | reactivated | reduced | blocked | restored | modified
  actorId: string | null;
  actorName: string;
  reason: string | null;
  createdAt: string; // ISO string
}

/**
 * #internet-history — Operador del <select> del historial de INTERNET (wire contract).
 * DISTINCT por actorId. Devuelto por ListInternetActivationOperators. Gate pppoe.read.
 */
export interface InternetActivationOperatorDto {
  actorId: string;
  actorName: string;
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
  // pppoe-plan-change-history: optional reason for the plan-change event.
  reason:        z.string().nullish(),
}).refine(
  (data) => Object.keys(data).filter(k => k !== 'reason').some(k => (data as Record<string, unknown>)[k] !== undefined),
  { message: 'At least one field must be provided' },
);

export type UpdatePppoeBody = z.infer<typeof UpdatePppoeBodySchema>;

export const MovePppoeBodySchema = z.object({
  nasId: z.string().min(1),
});

export type MovePppoeBody = z.infer<typeof MovePppoeBodySchema>;

/** Body de POST /pppoe/:id/associate — asocia un PPPoE huérfano a un contrato. */
export const AssociatePppoeBodySchema = z.object({
  contractId: z.string().min(1),
});

export type AssociatePppoeBody = z.infer<typeof AssociatePppoeBodySchema>;

// ── Fase C — enforcement (cortes) ────────────────────────────────────────────

const EnforcementActionSchema = z.enum(['reduce', 'block', 'restore']);

/** Body del corte INDIVIDUAL: POST /api/pppoe/:id/enforce */
export const EnforcePppoeBodySchema = z.object({
  action: EnforcementActionSchema,
  // pppoe-corte-individual: optional reason forwarded to the event log.
  reason: z.string().nullish(),
});
export type EnforcePppoeBody = z.infer<typeof EnforcePppoeBodySchema>;

/**
 * `target` del corte masivo/preview:
 *   "debtors"            → deudores (Client.status='late')
 *   { clientStatus }     → cualquier status (ej. "baja")
 *   { pppoeIds: [...] }  → lista explícita
 */
const EnforcementTargetSchema = z.union([
  z.literal('debtors'),
  z.object({ clientStatus: z.string().min(1) }),
  z.object({ pppoeIds: z.array(z.string().min(1)).min(1) }),
]);

/** Body de preview + bulk: { action, target } */
export const EnforceBulkBodySchema = z.object({
  action: EnforcementActionSchema,
  target: EnforcementTargetSchema,
});
export type EnforceBulkBody = z.infer<typeof EnforceBulkBodySchema>;

/** DTO del estado de un batch de corte (progreso poleable). */
export interface ServiceCutBatchDto {
  id: string;
  action: string;
  status: string;
  total: number;
  doneCount: number;
  failedCount: number;
  items: { pppoeId: string; ok: boolean; error?: string }[];
  createdAt: string;
  finishedAt: string | null;
}

export function toServiceCutBatchDto(b: {
  id: string;
  action: string;
  status: string;
  total: number;
  doneCount: number;
  failedCount: number;
  result: { pppoeId: string; ok: boolean; error?: string }[];
  createdAt: string;
  finishedAt: string | null;
}): ServiceCutBatchDto {
  return {
    id: b.id,
    action: b.action,
    status: b.status,
    total: b.total,
    doneCount: b.doneCount,
    failedCount: b.failedCount,
    items: b.result,
    createdAt: b.createdAt,
    finishedAt: b.finishedAt,
  };
}

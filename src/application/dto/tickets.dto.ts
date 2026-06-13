import { z } from 'zod';
import { TicketStatus, TicketPriority } from '@domain/entities/ticket';
import { TicketSlaConfig } from '@domain/ports/TicketSlaConfigRepository';

export interface ListTicketsQueryDto {
  page?: number;
  limit?: number;
  search?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  customerId?: string;
  areaId?: string;               // #49
  archived?: boolean;            // #85 — true = solo archivados; false/absent = excluye archivados
}

export interface CreateTicketDto {
  subject: string;
  description: string;
  customerId?: string | null;
  priority?: TicketPriority;
  assigneeId?: string | null;
  reporterId?: string | null;   // #48 — opcional; el route defaultea a req.user.id
  areaId?: string;              // #49 — required in route; optional in DTO (port mirrors reporterId)
}

export interface UpdateTicketDto {
  subject?: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
  areaId?: string | null;        // #49 — null clears; undefined = don't touch
}

/** Output DTO — never expose raw Prisma rows */
export interface TicketDto {
  id: string;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  customerId: string | null;
  customerName: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  reporterId: string | null;    // #48
  reporterName: string | null;  // #48 — JOIN-derived (RbacUser.name)
  areaId: string | null;        // #49
  areaName: string | null;      // #49 — JOIN-derived (TicketAreaCatalog.name)
  areaColor: string | null;     // #69 — JOIN-derived (TicketAreaCatalog.color)
  grCasoId: string | null;
  resolvedAt: string | null;     // #84 — ISO 8601; null until the ticket is closed
  archivedAt: string | null;     // #85 — ISO 8601; null until the ticket is archived
  createdAt: string;
  updatedAt: string;
}

// #69 — 6-digit hex color (e.g. #6366f1). Stricter than the status schema on
// purpose: the area pill renders the raw value as a CSS background, so we reject
// anything that isn't a valid hex string at the edge.
const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex like #6366f1');

// TicketArea catalog DTOs — name + pill color (#69)
export const CreateTicketAreaSchema = z.object({
  // .trim() before .min(1): a name of " " or "Soporte " would otherwise slip
  // past the uniqueness conflict check by carrying invisible whitespace.
  name: z.string().trim().min(1),
  color: HexColorSchema,
});
export const UpdateTicketAreaSchema = CreateTicketAreaSchema.partial();
export type CreateTicketAreaInput = z.infer<typeof CreateTicketAreaSchema>;
export type UpdateTicketAreaInput = z.infer<typeof UpdateTicketAreaSchema>;

// TicketStatus catalog DTOs (name + color + sort weight) — mirrors TaskPriority
export const CreateTicketStatusSchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
  weight: z.number().int(),
});
export const UpdateTicketStatusSchema = CreateTicketStatusSchema.partial();
export type CreateTicketStatusInput = z.infer<typeof CreateTicketStatusSchema>;
export type UpdateTicketStatusInput = z.infer<typeof UpdateTicketStatusSchema>;

// ---------------------------------------------------------------------------
// #79 — Ticket SLA timer config DTO (singleton; mirrors IClassClosureConfig)
// ---------------------------------------------------------------------------

/** API shape of the SLA timer thresholds (minutes). */
export interface TicketSlaConfigDto {
  warnMinutes: number;
  dangerMinutes: number;
}

export function toTicketSlaConfigDto(config: TicketSlaConfig): TicketSlaConfigDto {
  return { warnMinutes: config.warnMinutes, dangerMinutes: config.dangerMinutes };
}

/**
 * Zod schema for PUT /tickets/sla-config. Positive integer minutes, partial so
 * a single threshold can be patched. The cross-field invariant
 * (dangerMinutes > warnMinutes) is enforced in the use case against the MERGED
 * config — a partial body alone can't see the other side, so the route only
 * validates shape here.
 */
export const UpdateTicketSlaConfigSchema = z.object({
  warnMinutes: z.number().int().min(1),
  dangerMinutes: z.number().int().min(1),
}).partial().strict();

export type UpdateTicketSlaConfigInput = z.infer<typeof UpdateTicketSlaConfigSchema>;

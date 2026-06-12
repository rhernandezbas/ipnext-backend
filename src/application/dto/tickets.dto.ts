import { z } from 'zod';
import { TicketStatus, TicketPriority } from '@domain/entities/ticket';

export interface ListTicketsQueryDto {
  page?: number;
  limit?: number;
  search?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  customerId?: string;
  areaId?: string;               // #49
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
  grCasoId: string | null;
  createdAt: string;
  updatedAt: string;
}

// TicketArea catalog DTOs — simple name-only catalog
export const CreateTicketAreaSchema = z.object({
  // .trim() before .min(1): a name of " " or "Soporte " would otherwise slip
  // past the uniqueness conflict check by carrying invisible whitespace.
  name: z.string().trim().min(1),
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

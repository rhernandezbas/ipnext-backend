import { z } from 'zod';
import { TicketStatus, TicketPriority } from '@domain/entities/ticket';

export interface ListTicketsQueryDto {
  page?: number;
  limit?: number;
  search?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  customerId?: string;
}

export interface CreateTicketDto {
  subject: string;
  description: string;
  customerId?: string | null;
  priority?: TicketPriority;
  assigneeId?: string | null;
  reporterId?: string | null;   // #48 — opcional; el route defaultea a req.user.id
}

export interface UpdateTicketDto {
  subject?: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeId?: string | null;
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
  grCasoId: string | null;
  createdAt: string;
  updatedAt: string;
}

// TicketStatus catalog DTOs (name + color + sort weight) — mirrors TaskPriority
export const CreateTicketStatusSchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
  weight: z.number().int(),
});
export const UpdateTicketStatusSchema = CreateTicketStatusSchema.partial();
export type CreateTicketStatusInput = z.infer<typeof CreateTicketStatusSchema>;
export type UpdateTicketStatusInput = z.infer<typeof UpdateTicketStatusSchema>;

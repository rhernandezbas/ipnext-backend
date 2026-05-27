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
  grCasoId: string | null;
  createdAt: string;
  updatedAt: string;
}

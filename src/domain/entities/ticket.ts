export type TicketPriority = 'low' | 'medium' | 'high';
export type TicketStatus = 'open' | 'pending' | 'closed';

export interface Ticket {
  id: string;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  customerId: string | null;
  customerName: string | null;   // JOIN-derived (Client.name) — NOT free text
  assigneeId: string | null;
  assigneeName: string | null;   // JOIN-derived (Admin.name)
  grCasoId: string | null;
  createdAt: string;             // ISO 8601
  updatedAt: string;             // ISO 8601
}

export interface TicketStats {
  totalOpen: number;
  totalPending: number;
  totalClosed: number;
  byPriority: { low: number; medium: number; high: number };
}

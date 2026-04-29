export type TicketPriority = 'alta' | 'media' | 'baja';
export type TicketStatus = 'abierto' | 'en_progreso' | 'cerrado';

export interface Ticket {
  id: string;
  subject: string;
  clientId: string;
  clientName: string;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo?: string;
  description: string;
  createdAt: string;
}

export interface TicketStats {
  totalOpen: number;
  byPriority: { alta: number; media: number; baja: number };
  assignedToCurrentUser: number;
}

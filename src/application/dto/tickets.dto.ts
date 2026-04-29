export interface ListTicketsQueryDto {
  page?: number;
  limit?: number;
  search?: string;
  status?: string;
  priority?: string;
}

export interface CreateTicketDto {
  subject: string;
  clientId: string;
  priority: 'alta' | 'media' | 'baja';
  description: string;
  assignedTo?: string;
}

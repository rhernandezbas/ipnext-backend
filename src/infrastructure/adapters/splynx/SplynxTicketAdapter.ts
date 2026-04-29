import { TicketRepository, ListTicketsQuery, CreateTicketData } from '@domain/ports/TicketRepository';
import { Ticket, TicketPriority, TicketStatus, TicketStats } from '@domain/entities/ticket';
import { PaginatedResult } from '@application/dto/pagination';
import { SplynxClient } from './SplynxClient';

function mapPriority(s: string | number): TicketPriority {
  const map: Record<string, TicketPriority> = { '1': 'alta', 'high': 'alta', '2': 'media', 'medium': 'media', '3': 'baja', 'low': 'baja' };
  return map[String(s)] ?? 'media';
}

function mapTicketStatus(s: string | number): TicketStatus {
  const map: Record<string, TicketStatus> = { '1': 'abierto', 'open': 'abierto', '2': 'en_progreso', 'in_progress': 'en_progreso', '3': 'cerrado', 'closed': 'cerrado' };
  return map[String(s)] ?? 'abierto';
}

export class SplynxTicketAdapter implements TicketRepository {
  constructor(private readonly client: SplynxClient) {}

  async list(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>> {
    const params: Record<string, unknown> = { page: query.page, itemsPerPage: query.limit };
    if (query.search) params['search'] = query.search;
    if (query.status) params['status'] = query.status;
    if (query.priority) params['priority'] = query.priority;

    const raw = await this.client.get<Record<string, unknown>[]>('/api/2.0/admin/support/ticket', params);
    const data = Array.isArray(raw) ? raw : [];
    return {
      data: data.map((t) => ({
        id: String(t['id'] ?? ''),
        subject: String(t['subject'] ?? ''),
        clientId: String(t['customer_id'] ?? ''),
        clientName: String(t['customer_name'] ?? ''),
        priority: mapPriority(String(t['priority'] ?? '')),
        status: mapTicketStatus(String(t['status'] ?? '')),
        assignedTo: t['admin_id'] ? String(t['admin_id']) : undefined,
        description: String(t['message'] ?? ''),
        createdAt: String(t['date_created'] ?? ''),
      })),
      total: data.length,
      page: query.page ?? 1,
      limit: query.limit ?? 25,
    };
  }

  async getStats(): Promise<TicketStats> {
    const raw = await this.client.get<Record<string, unknown>[]>('/api/2.0/admin/support/ticket', { status: 'open', itemsPerPage: 1000 });
    const tickets = Array.isArray(raw) ? raw : [];
    return {
      totalOpen: tickets.length,
      byPriority: {
        alta: tickets.filter((t) => mapPriority(String(t['priority'] ?? '')) === 'alta').length,
        media: tickets.filter((t) => mapPriority(String(t['priority'] ?? '')) === 'media').length,
        baja: tickets.filter((t) => mapPriority(String(t['priority'] ?? '')) === 'baja').length,
      },
      assignedToCurrentUser: 0,
    };
  }

  async create(data: CreateTicketData): Promise<Ticket> {
    const raw = await this.client.post<Record<string, unknown>>('/api/2.0/admin/support/ticket', {
      subject: data.subject,
      customer_id: data.clientId,
      priority: data.priority === 'alta' ? 1 : data.priority === 'media' ? 2 : 3,
      message: data.description,
      admin_id: data.assignedTo,
    });
    return {
      id: String(raw['id'] ?? ''),
      subject: data.subject,
      clientId: data.clientId,
      clientName: '',
      priority: data.priority,
      status: 'abierto',
      assignedTo: data.assignedTo,
      description: data.description,
      createdAt: new Date().toISOString(),
    };
  }
}

/**
 * SplynxTicketAdapter — DECABLED (not wired in app.ts).
 * Preserved for rollback purposes (AD-2 in design.md tickets-model change).
 * Updated to implement the new TicketRepository port shape.
 * Splynx integration is non-functional (license expired) — stubs return sensible no-ops.
 */
import { TicketRepository, ListTicketsQuery, CreateTicketData, UpdateTicketData } from '@domain/ports/TicketRepository';
import { Ticket, TicketPriority, TicketStatus, TicketStats } from '@domain/entities/ticket';
import { PaginatedResult } from '@application/dto/pagination';
import { SplynxClient } from './SplynxClient';

function mapPriority(s: string | number): TicketPriority {
  const map: Record<string, TicketPriority> = {
    '1': 'high', 'high': 'high',
    '2': 'medium', 'medium': 'medium',
    '3': 'low', 'low': 'low',
  };
  return map[String(s)] ?? 'medium';
}

function mapTicketStatus(s: string | number): TicketStatus {
  const map: Record<string, TicketStatus> = {
    '1': 'open', 'open': 'open',
    '2': 'pending', 'in_progress': 'pending', 'pending': 'pending',
    '3': 'closed', 'closed': 'closed',
  };
  return map[String(s)] ?? 'open';
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
        sequenceNumber: Number(t['id']) || 0, // legacy Splynx: reuse its numeric id as display number
        subject: String(t['subject'] ?? ''),
        description: String(t['message'] ?? ''),
        customerId: t['customer_id'] ? String(t['customer_id']) : null,
        customerName: t['customer_name'] ? String(t['customer_name']) : null,
        contractId: null,    // Splynx legacy has no contract FK on tickets
        priority: mapPriority(String(t['priority'] ?? '')),
        status: mapTicketStatus(String(t['status'] ?? '')),
        assigneeId: t['admin_id'] ? String(t['admin_id']) : null,
        assigneeName: null,
        reporterId: null,    // Splynx legacy has no reporter concept (decabled)
        reporterName: null,
        areaId: null,        // #49 — Splynx legacy has no area concept
        areaName: null,
        areaColor: null,
        grCasoId: null,
        resolvedAt: null,    // #84 — Splynx legacy has no resolvedAt concept
        archivedAt: null,    // #85 — Splynx legacy has no archivedAt concept
        createdAt: String(t['date_created'] ?? new Date().toISOString()),
        updatedAt: String(t['date_created'] ?? new Date().toISOString()),
      })),
      total: data.length,
      page: query.page ?? 1,
      limit: query.limit ?? 25,
    };
  }

  async getById(_id: string): Promise<Ticket | null> {
    // Stub — Splynx decabled
    return null;
  }

  async getBySequenceNumber(_sequenceNumber: number): Promise<Ticket | null> {
    // Stub — Splynx decabled (C3: mirror of getById; Splynx has no sequenceNumber concept).
    return null;
  }

  async getStats(): Promise<TicketStats> {
    const raw = await this.client.get<Record<string, unknown>[]>('/api/2.0/admin/support/ticket', { status: 'open', itemsPerPage: 1000 });
    const tickets = Array.isArray(raw) ? raw : [];
    return {
      totalOpen: tickets.length,
      totalPending: 0,
      totalClosed: 0,
      byPriority: {
        high: tickets.filter((t) => mapPriority(String(t['priority'] ?? '')) === 'high').length,
        medium: tickets.filter((t) => mapPriority(String(t['priority'] ?? '')) === 'medium').length,
        low: tickets.filter((t) => mapPriority(String(t['priority'] ?? '')) === 'low').length,
      },
    };
  }

  async create(data: CreateTicketData): Promise<Ticket> {
    const raw = await this.client.post<Record<string, unknown>>('/api/2.0/admin/support/ticket', {
      subject: data.subject,
      customer_id: data.customerId,
      priority: data.priority === 'high' ? 1 : data.priority === 'medium' ? 2 : 3,
      message: data.description,
      admin_id: data.assigneeId,
    });
    return {
      id: String(raw['id'] ?? ''),
      sequenceNumber: Number(raw['id']) || 0, // legacy Splynx: reuse its numeric id
      subject: data.subject,
      description: data.description,
      customerId: data.customerId ?? null,
      customerName: null,
      contractId: data.contractId ?? null,
      priority: data.priority ?? 'medium',
      status: 'open',
      assigneeId: data.assigneeId ?? null,
      assigneeName: null,
      reporterId: data.reporterId ?? null,    // #48
      reporterName: null,
      areaId: null,           // #49 — Splynx legacy has no area concept
      areaName: null,
      areaColor: null,
      grCasoId: null,
      resolvedAt: null,       // #84 — Splynx legacy has no resolvedAt concept
      archivedAt: null,       // #85 — Splynx legacy has no archivedAt concept
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async update(_id: string, _data: UpdateTicketData): Promise<Ticket | null> {
    // Stub — Splynx decabled
    return null;
  }

  async close(_id: string): Promise<Ticket | null> {
    // Stub — Splynx decabled
    return null;
  }

  async archive(_id: string): Promise<Ticket | null> {
    // Stub — Splynx decabled
    return null;
  }

  async delete(_id: string): Promise<boolean> {
    // Stub — Splynx decabled
    return false;
  }

  async countOpenByClientIds(_clientIds: string[]): Promise<Map<string, number>> {
    // Stub — Splynx decabled (portfolio Fase 3 is Prisma-only).
    return new Map();
  }

  async countClosedByClientIds(_clientIds: string[]): Promise<Map<string, number>> {
    // Stub — Splynx decabled (states-be, F1.5 spec #2, is Prisma-only).
    return new Map();
  }

  async markMessagesRead(_ticketId: string, _side: 'client' | 'staff'): Promise<void> {
    // Stub — Splynx decabled (v2.B, portal-ticket-messaging, is Prisma-only).
  }
}

import { Ticket, TicketStats, TicketPriority } from '@domain/entities/ticket';
import { TicketRepository, ListTicketsQuery, CreateTicketData, UpdateTicketData } from '@domain/ports/TicketRepository';
import { PaginatedResult } from '@application/dto/pagination';

// Minimal in-memory customer map for JOIN-derived customerName in tests
export interface InMemoryCustomer {
  id: string;
  name: string;
}

// Minimal in-memory admin map for JOIN-derived assigneeName in tests
export interface InMemoryAdmin {
  id: string;
  name: string;
}

let nextId = 1;
let nextSeq = 1; // #11 — monotonic sequenceNumber, like ScheduledTask

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryTicketRepository implements TicketRepository {
  private tickets: Ticket[] = [];
  private customers: Map<string, InMemoryCustomer> = new Map();
  private admins: Map<string, InMemoryAdmin> = new Map();

  /** Seed customers so the repo can resolve customerName from JOIN */
  seedCustomers(customers: InMemoryCustomer[]): void {
    for (const c of customers) {
      this.customers.set(c.id, c);
    }
  }

  /** Seed admins so the repo can resolve assigneeName from JOIN */
  seedAdmins(admins: InMemoryAdmin[]): void {
    for (const a of admins) {
      this.admins.set(a.id, a);
    }
  }

  async list(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>> {
    let results = [...this.tickets];

    if (query.customerId) {
      results = results.filter((t) => t.customerId === query.customerId);
    }
    if (query.status) {
      results = results.filter((t) => t.status === query.status);
    }
    if (query.priority) {
      results = results.filter((t) => t.priority === query.priority);
    }
    if (query.assigneeId) {
      results = results.filter((t) => t.assigneeId === query.assigneeId);
    }
    if (query.from) {
      results = results.filter((t) => t.createdAt >= query.from!);
    }
    if (query.to) {
      const end = `${query.to}T23:59:59.999Z`;
      results = results.filter((t) => t.createdAt <= end);
    }
    if (query.search) {
      const q = query.search.toLowerCase();
      results = results.filter(
        (t) =>
          t.subject.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q),
      );
    }

    const total = results.length;
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const start = (page - 1) * limit;
    const data = results.slice(start, start + limit);

    return { data, total, page, limit };
  }

  async getById(id: string): Promise<Ticket | null> {
    return this.tickets.find((t) => t.id === id) ?? null;
  }

  async getStats(): Promise<TicketStats> {
    const totalOpen = this.tickets.filter((t) => t.status === 'open').length;
    const totalPending = this.tickets.filter((t) => t.status === 'pending').length;
    const totalClosed = this.tickets.filter((t) => t.status === 'closed').length;
    const byPriority = {
      low: this.tickets.filter((t) => t.priority === 'low').length,
      medium: this.tickets.filter((t) => t.priority === 'medium').length,
      high: this.tickets.filter((t) => t.priority === 'high').length,
    };
    return { totalOpen, totalPending, totalClosed, byPriority };
  }

  async create(data: CreateTicketData): Promise<Ticket> {
    const id = String(nextId++);
    const now = nowIso();
    const customerName = data.customerId
      ? (this.customers.get(data.customerId)?.name ?? null)
      : null;
    const assigneeName = data.assigneeId
      ? (this.admins.get(data.assigneeId)?.name ?? null)
      : null;

    const ticket: Ticket = {
      id,
      sequenceNumber: nextSeq++,
      subject: data.subject,
      description: data.description,
      status: 'open',
      priority: data.priority ?? 'medium',
      customerId: data.customerId ?? null,
      customerName,
      assigneeId: data.assigneeId ?? null,
      assigneeName,
      grCasoId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tickets.push(ticket);
    return ticket;
  }

  async update(id: string, data: UpdateTicketData): Promise<Ticket | null> {
    const idx = this.tickets.findIndex((t) => t.id === id);
    if (idx === -1) return null;

    const existing = this.tickets[idx]!;
    const assigneeName =
      data.assigneeId !== undefined
        ? (data.assigneeId ? (this.admins.get(data.assigneeId)?.name ?? null) : null)
        : existing.assigneeName;

    const updated: Ticket = {
      ...existing,
      ...(data.subject !== undefined && { subject: data.subject }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.priority !== undefined && { priority: data.priority }),
      ...(data.assigneeId !== undefined && { assigneeId: data.assigneeId ?? null, assigneeName }),
      updatedAt: nowIso(),
    };
    this.tickets[idx] = updated;
    return updated;
  }

  async close(id: string): Promise<Ticket | null> {
    return this.update(id, { status: 'closed' });
  }
}

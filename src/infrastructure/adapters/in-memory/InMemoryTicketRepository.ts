import { Ticket, TicketStats, TicketPriority } from '@domain/entities/ticket';
import { isClosedStatus } from '@domain/entities/ticketStatus';
import { TicketRepository, ListTicketsQuery, CreateTicketData, UpdateTicketData } from '@domain/ports/TicketRepository';
import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import { PaginatedResult } from '@application/dto/pagination';
import { sequenceNumberClause } from '../search/sequenceNumberClause';

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
  // #49 — area catalog reference for JOIN-derived areaName. Accepts the same
  // InMemoryTicketAreaCatalogRepository used in tests so both repos share state.
  private areaRepo: TicketAreaCatalogRepository | null = null;

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

  /** #49 — link a shared TicketAreaCatalogRepository so areaName resolves via JOIN */
  seedAreas(repo: TicketAreaCatalogRepository): void {
    this.areaRepo = repo;
  }

  async list(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>> {
    let results = [...this.tickets];

    // #85 — archived filter: default excludes archived; archived:true returns only archived
    if (query.archived === true) {
      results = results.filter((t) => t.archivedAt != null);
    } else {
      results = results.filter((t) => t.archivedAt == null);
    }

    if (query.customerId) {
      results = results.filter((t) => t.customerId === query.customerId);
    }
    if (query.status) {
      // M2 (#46): case-insensitive — protects Archive ('closed' vs 'Closed').
      const wanted = query.status.toLowerCase();
      results = results.filter((t) => t.status.toLowerCase() === wanted);
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
    if (query.areaId) {
      results = results.filter((t) => t.areaId === query.areaId);
    }
    if (query.search) {
      const q = query.search.toLowerCase();
      // #63 — LIKE over subject + customer.name + sequenceNumber (exact if numeric)
      // Mirror the Prisma int4-overflow guard so the seam is faithful: a numeric
      // term that overflows a signed 32-bit int never participates in the exact
      // sequenceNumber match (the Prisma side skips that clause to avoid a 500).
      // Same shared helper as PrismaTicketRepository — single source of truth.
      const seqClause = sequenceNumberClause(query.search);
      results = results.filter(
        (t) =>
          t.subject.toLowerCase().includes(q) ||
          (t.customerName != null && t.customerName.toLowerCase().includes(q)) ||
          (seqClause !== null && t.sequenceNumber === seqClause.sequenceNumber),
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
    // #48 — reporterName resuelto del mismo admins map que assigneeName (JOIN espejo).
    const reporterName = data.reporterId
      ? (this.admins.get(data.reporterId)?.name ?? null)
      : null;
    // #49 — areaName resolved from the shared area catalog (JOIN-derived, like customerName).
    const areaId = data.areaId ?? null;
    let areaName: string | null = null;
    let areaColor: string | null = null;   // #69
    if (areaId && this.areaRepo) {
      const areaEntry = await this.areaRepo.getById(areaId);
      areaName = areaEntry?.name ?? null;
      areaColor = areaEntry?.color ?? null;
    }

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
      reporterId: data.reporterId ?? null,
      reporterName,
      areaId,
      areaName,
      areaColor,
      grCasoId: null,
      resolvedAt: null, // #84 — null until close() is called
      archivedAt: null, // #85 — null until archive() is called
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

    // #49 — areaName resolved when areaId is explicitly set in the update.
    // areaId === undefined → don't touch; areaId === null → clear; areaId = id → resolve name.
    let areaId = existing.areaId;
    let areaName = existing.areaName;
    let areaColor = existing.areaColor;   // #69
    if (data.areaId !== undefined) {
      areaId = data.areaId ?? null;
      if (areaId && this.areaRepo) {
        const areaEntry = await this.areaRepo.getById(areaId);
        areaName = areaEntry?.name ?? null;
        areaColor = areaEntry?.color ?? null;
      } else {
        areaName = null;
        areaColor = null;
      }
    }

    // #84 — keep resolvedAt consistent with the status transition. A status change
    // to a closed-like status stamps resolvedAt; any other status clears it (reopen).
    // Detection is catalog-aligned + case-insensitive (lección #46), never hardcoded
    // to a single literal. When data.status is undefined we don't touch resolvedAt.
    let resolvedAt = existing.resolvedAt;
    if (data.status !== undefined) {
      resolvedAt = isClosedStatus(data.status) ? nowIso() : null;
    }

    const updated: Ticket = {
      ...existing,
      ...(data.subject !== undefined && { subject: data.subject }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.status !== undefined && { status: data.status, resolvedAt }),
      ...(data.priority !== undefined && { priority: data.priority }),
      ...(data.assigneeId !== undefined && { assigneeId: data.assigneeId ?? null, assigneeName }),
      ...(data.areaId !== undefined && { areaId, areaName, areaColor }),
      updatedAt: nowIso(),
    };
    this.tickets[idx] = updated;
    return updated;
  }

  async close(id: string, statusName: string): Promise<Ticket | null> {
    // #84 — close goes through update(); the stamping of resolvedAt is now unified
    // there (a closed-like status stamps it). No extra patching needed.
    return this.update(id, { status: statusName });
  }

  async archive(id: string): Promise<Ticket | null> {
    const idx = this.tickets.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    // #85 re-review — idempotent: don't re-stamp archivedAt if already archived
    // (mirror of PrismaTicketRepository.archive / ArchiveTask #86).
    const current = this.tickets[idx]!;
    if (current.archivedAt != null) return current;
    const stamped: Ticket = { ...current, archivedAt: nowIso() };
    this.tickets[idx] = stamped;
    return stamped;
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.tickets.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.tickets.splice(idx, 1);
    return true;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: This file uses `as any` casts on the Prisma client calls because
 * `prisma generate` must be run after the migration is applied.
 * The casts are safe — the schema and columns are correct.
 *
 * Phase 2 contract:
 *  - DB stores statusId (FK to TicketStatusCatalog).
 *  - The domain Ticket carries `status` as the catalog NAME string.
 *  - This repository is the translation boundary: name↔id is resolved HERE.
 *    Use cases and DTOs never see statusId.
 */
import { Ticket, TicketStats } from '@domain/entities/ticket';
import { TicketRepository, ListTicketsQuery, CreateTicketData, UpdateTicketData } from '@domain/ports/TicketRepository';
import { PaginatedResult } from '@application/dto/pagination';
import { TicketStatusUnknownError } from '@domain/errors/tickets';
import { prisma } from '../../database/prisma';

const INCLUDE = {
  status: true,                                          // Phase 2: resolve name from relation
  customer: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
} as const;

export function toTicket(row: any): Ticket {
  return {
    id: row.id,
    sequenceNumber: row.sequenceNumber,
    subject: row.subject,
    description: row.description,
    // Phase 2: status is a relation; expose name (the API contract string).
    // If the relation is already a string (e.g. test fixtures), use it directly.
    status: typeof row.status === 'object' && row.status !== null
      ? row.status.name
      : row.status,
    priority: row.priority,
    customerId: row.customerId ?? null,
    customerName: row.customer?.name ?? null,
    assigneeId: row.assigneeId ?? null,
    assigneeName: row.assignee?.name ?? null,
    grCasoId: row.grCasoId ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
    // #44 (D7) — related tasks only present when the query included them (getById).
    ...(Array.isArray(row.tasks) && {
      tasks: row.tasks.map((t: any) => ({
        id: t.id,
        sequenceNumber: t.sequenceNumber,
        title: t.title,
      })),
    }),
  };
}

/**
 * Resolve a status NAME to the matching TicketStatusCatalog id.
 * Throws TicketStatusUnknownError if no catalog entry matches.
 */
async function resolveStatusId(name: string): Promise<string> {
  // Case-insensitive: tolerate casing drift between the API string and the
  // canonical catalog name (e.g. 'closed' vs 'Closed') so close()/update()
  // never 500 on a mismatch that is really just a different casing.
  const row = await (prisma as any).ticketStatusCatalog.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true },
  });
  if (!row) throw new TicketStatusUnknownError(name);
  return row.id;
}

export class PrismaTicketRepository implements TicketRepository {
  async list(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>> {
    const where: Record<string, unknown> = {};

    if (query.customerId) where['customerId'] = query.customerId;
    if (query.priority) where['priority'] = query.priority;
    if (query.assigneeId) where['assigneeId'] = query.assigneeId; // #25
    if (query.from || query.to) { // #25 — rango por createdAt
      where['createdAt'] = {
        ...(query.from && { gte: new Date(query.from) }),
        ...(query.to && { lte: new Date(`${query.to}T23:59:59.999Z`) }),
      };
    }
    // Phase 2: filter by status name via the relation.
    // M2 (#46): case-insensitive — protects Archive ('closed' vs 'Closed').
    if (query.status) {
      where['status'] = { name: { equals: query.status, mode: 'insensitive' } };
    }
    if (query.search) {
      where['OR'] = [
        { subject: { contains: query.search, mode: 'insensitive' } },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const skip = (page - 1) * limit;

    const [rows, total] = await (prisma as any).$transaction([
      (prisma as any).ticket.findMany({
        where,
        include: INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      (prisma as any).ticket.count({ where }),
    ]);

    return {
      data: rows.map(toTicket),
      total,
      page,
      limit,
    };
  }

  async getById(id: string): Promise<Ticket | null> {
    const row = await (prisma as any).ticket.findUnique({
      where: { id },
      include: {
        ...INCLUDE,
        // #44 (D7) — enrich the single-ticket read with its related tasks.
        tasks: { select: { id: true, sequenceNumber: true, title: true } },
      },
    });
    return row ? toTicket(row) : null;
  }

  async getStats(): Promise<TicketStats> {
    const [totalOpen, totalPending, totalClosed, byLow, byMedium, byHigh] = await (
      prisma as any
    ).$transaction([
      (prisma as any).ticket.count({ where: { status: { name: 'open' } } }),
      (prisma as any).ticket.count({ where: { status: { name: 'pending' } } }),
      (prisma as any).ticket.count({ where: { status: { name: 'closed' } } }),
      (prisma as any).ticket.count({ where: { priority: 'low' } }),
      (prisma as any).ticket.count({ where: { priority: 'medium' } }),
      (prisma as any).ticket.count({ where: { priority: 'high' } }),
    ]);

    return {
      totalOpen,
      totalPending,
      totalClosed,
      byPriority: { low: byLow, medium: byMedium, high: byHigh },
    };
  }

  async create(data: CreateTicketData): Promise<Ticket> {
    // Default status is 'open'; resolve to catalog id.
    const statusName = 'open';
    const statusId = await resolveStatusId(statusName);

    const row = await (prisma as any).ticket.create({
      data: {
        subject: data.subject,
        description: data.description,
        priority: data.priority ?? 'medium',
        statusId,
        ...(data.customerId != null && { customerId: data.customerId }),
        ...(data.assigneeId != null && { assigneeId: data.assigneeId }),
      },
      include: INCLUDE,
    });
    return toTicket(row);
  }

  async update(id: string, data: UpdateTicketData): Promise<Ticket | null> {
    try {
      const updateData: Record<string, unknown> = {};
      if (data.subject !== undefined) updateData['subject'] = data.subject;
      if (data.description !== undefined) updateData['description'] = data.description;
      if (data.priority !== undefined) updateData['priority'] = data.priority;
      if (data.assigneeId !== undefined) updateData['assigneeId'] = data.assigneeId;
      // Phase 2: resolve status name → id at the repo boundary.
      if (data.status !== undefined) {
        updateData['statusId'] = await resolveStatusId(data.status);
      }

      const row = await (prisma as any).ticket.update({
        where: { id },
        data: updateData,
        include: INCLUDE,
      });
      return toTicket(row);
    } catch (err: any) {
      // Prisma P2025 = record not found
      if (err?.code === 'P2025') return null;
      throw err;
    }
  }

  async close(id: string, statusName: string): Promise<Ticket | null> {
    // statusName is the canonical catalog name resolved by CloseTicket.
    return this.update(id, { status: statusName });
  }
}

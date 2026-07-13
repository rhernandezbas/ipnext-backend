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
import { isClosedStatus } from '@domain/entities/ticketStatus';
import { TicketRepository, ListTicketsQuery, CreateTicketData, UpdateTicketData } from '@domain/ports/TicketRepository';
import { PaginatedResult } from '@application/dto/pagination';
import { TicketStatusUnknownError } from '@domain/errors/tickets';
import { sequenceNumberClause } from '../search/sequenceNumberClause';
import { prisma } from '../../database/prisma';

const INCLUDE = {
  status: true,                                          // Phase 2: resolve name from relation
  customer: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  reporter: { select: { id: true, name: true } },       // #48 — JOIN para reporterName (espejo de assignee)
  area: { select: { id: true, name: true, color: true } }, // #49 areaName / #69 areaColor
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
    contractId: row.contractId ?? null,
    assigneeId: row.assigneeId ?? null,
    assigneeName: row.assignee?.name ?? null,
    // #48 — reporter denormalizado igual que assignee.
    reporterId: row.reporterId ?? null,
    reporterName: row.reporter?.name ?? null,
    // #49 — área denormalizada igual que customer/assignee/reporter.
    areaId: row.areaId ?? null,
    areaName: row.area?.name ?? null,
    areaColor: row.area?.color ?? null,   // #69
    grCasoId: row.grCasoId ?? null,
    // #84 — resolvedAt: stamped when the ticket is closed; null otherwise.
    resolvedAt: row.resolvedAt instanceof Date
      ? row.resolvedAt.toISOString()
      : (row.resolvedAt ?? null),
    // #85 — archivedAt: stamped when the ticket is archived; null otherwise.
    archivedAt: row.archivedAt instanceof Date
      ? row.archivedAt.toISOString()
      : (row.archivedAt ?? null),
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
    // #49 — filter by areaId (AND alongside any existing OR search clause)
    if (query.areaId) where['areaId'] = query.areaId;
    if (query.search) {
      // #63 — LIKE over subject + customer.name + sequenceNumber (exact if numeric)
      const or: unknown[] = [
        { subject: { contains: query.search, mode: 'insensitive' } },
        { customer: { is: { name: { contains: query.search, mode: 'insensitive' } } } },
      ];
      // Guard the numeric arm: a long digit string (phone / CUIT pasted into the
      // search box) overflows PostgreSQL's int4 and makes Prisma throw a
      // PrismaClientValidationError → 500. The shared helper returns the exact
      // clause only when the value fits a signed 32-bit int (the sequenceNumber
      // column type), and null otherwise. Unit-tested in isolation.
      const seqClause = sequenceNumberClause(query.search);
      if (seqClause) or.push(seqClause);
      where['OR'] = or;
    }

    // #85 — archived filter: default excludes archived; archived:true returns only archived
    if (query.archived === true) {
      where['archivedAt'] = { not: null };
    } else {
      where['archivedAt'] = null;
    }

    // fix-be #2 — "solo abiertos", MISMA semántica que countOpenByClientIds (resolvedAt
    // null AND archivedAt null). archivedAt ya quedó en null arriba (default, no-archived).
    if (query.openOnly === true) {
      where['resolvedAt'] = null;
    }

    // states-be (F1.5 spec #2) — "solo cerrados", MISMA semántica que
    // countClosedByClientIds (resolvedAt NOT null AND archivedAt null). archivedAt
    // ya quedó en null arriba (default, no-archived).
    if (query.closedOnly === true) {
      where['resolvedAt'] = { not: null };
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
        ...(data.contractId != null && { contractId: data.contractId }),
        ...(data.assigneeId != null && { assigneeId: data.assigneeId }),
        ...(data.reporterId != null && { reporterId: data.reporterId }),   // #48
        ...(data.areaId != null && { areaId: data.areaId }),               // #49
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
      // #49 — areaId: null clears it, a string sets it, undefined skips.
      if (data.areaId !== undefined) updateData['areaId'] = data.areaId ?? null;
      // Phase 2: resolve status name → id at the repo boundary.
      if (data.status !== undefined) {
        updateData['statusId'] = await resolveStatusId(data.status);
        // #84 — keep resolvedAt consistent with the transition: a closed-like status
        // stamps it; reopening to any other status clears it (null while open).
        // Detection is catalog-aligned + case-insensitive (lección #46).
        updateData['resolvedAt'] = isClosedStatus(data.status) ? new Date() : null;
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
    // #84 — stamp resolvedAt at the persistence layer so the SLA timer can freeze.
    try {
      const statusId = await resolveStatusId(statusName);
      const row = await (prisma as any).ticket.update({
        where: { id },
        data: { statusId, resolvedAt: new Date() },
        include: INCLUDE,
      });
      return toTicket(row);
    } catch (err: any) {
      if (err?.code === 'P2025') return null;
      throw err;
    }
  }

  async archive(id: string): Promise<Ticket | null> {
    // #85 — stamp archivedAt. Caller (ArchiveTicket) validates the ticket is closed.
    // #85 re-review — idempotent: if the ticket is already archived, return it as-is
    // without re-stamping archivedAt (same pattern as ArchiveTask, #86).
    try {
      const existing = await (prisma as any).ticket.findUnique({
        where: { id },
        include: INCLUDE,
      });
      if (!existing) return null;
      if (existing.archivedAt != null) return toTicket(existing);

      const row = await (prisma as any).ticket.update({
        where: { id },
        data: { archivedAt: new Date() },
        include: INCLUDE,
      });
      return toTicket(row);
    } catch (err: any) {
      if (err?.code === 'P2025') return null;
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    // #85 — hard delete. Returns false if not found (P2025).
    try {
      await (prisma as any).ticket.delete({ where: { id } });
      return true;
    } catch (err: any) {
      if (err?.code === 'P2025') return false;
      throw err;
    }
  }

  async countOpenByClientIds(clientIds: string[]): Promise<Map<string, number>> {
    // Portfolio (Fase 3) — open tickets per client in a SINGLE aggregated query.
    // "Open" = resolvedAt null AND archivedAt null (the casing-safe terminal
    // signal — resolvedAt is unified-stamped on close regardless of catalog
    // casing; archived tickets are not "open" either). No N+1.
    const result = new Map<string, number>();
    if (clientIds.length === 0) return result; // skip the query entirely
    const rows: any[] = await (prisma as any).ticket.groupBy({
      by: ['customerId'],
      where: { customerId: { in: clientIds }, resolvedAt: null, archivedAt: null },
      _count: { _all: true },
    });
    for (const row of rows) {
      if (row.customerId == null) continue;
      result.set(row.customerId, row._count?._all ?? 0);
    }
    return result;
  }

  async countClosedByClientIds(clientIds: string[]): Promise<Map<string, number>> {
    // states-be (F1.5 spec #2) — mirror of countOpenByClientIds for CLOSED
    // tickets in a SINGLE aggregated query. "Closed" = resolvedAt NOT null AND
    // archivedAt null (same terminal signal as `closedOnly`). No N+1.
    const result = new Map<string, number>();
    if (clientIds.length === 0) return result; // skip the query entirely
    const rows: any[] = await (prisma as any).ticket.groupBy({
      by: ['customerId'],
      where: { customerId: { in: clientIds }, resolvedAt: { not: null }, archivedAt: null },
      _count: { _all: true },
    });
    for (const row of rows) {
      if (row.customerId == null) continue;
      result.set(row.customerId, row._count?._all ?? 0);
    }
    return result;
  }
}

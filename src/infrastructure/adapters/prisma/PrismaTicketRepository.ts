/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: This file uses `as any` casts on the Prisma client calls because
 * `prisma generate` must be run after the migration is applied.
 * The casts are safe — the schema and columns are correct.
 */
import { Ticket, TicketStats } from '@domain/entities/ticket';
import { TicketRepository, ListTicketsQuery, CreateTicketData, UpdateTicketData } from '@domain/ports/TicketRepository';
import { PaginatedResult } from '@application/dto/pagination';
import { prisma } from '../../database/prisma';

const INCLUDE = {
  customer: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
} as const;

export function toTicket(row: any): Ticket {
  return {
    id: row.id,
    subject: row.subject,
    description: row.description,
    status: row.status,
    priority: row.priority,
    customerId: row.customerId ?? null,
    customerName: row.customer?.name ?? null,    // JOIN-derived only
    assigneeId: row.assigneeId ?? null,
    assigneeName: row.assignee?.name ?? null,    // JOIN-derived only
    grCasoId: row.grCasoId ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

export class PrismaTicketRepository implements TicketRepository {
  async list(query: ListTicketsQuery): Promise<PaginatedResult<Ticket>> {
    const where: Record<string, unknown> = {};

    if (query.customerId) where['customerId'] = query.customerId;
    if (query.status) where['status'] = query.status;
    if (query.priority) where['priority'] = query.priority;
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
      include: INCLUDE,
    });
    return row ? toTicket(row) : null;
  }

  async getStats(): Promise<TicketStats> {
    const [totalOpen, totalPending, totalClosed, byLow, byMedium, byHigh] = await (
      prisma as any
    ).$transaction([
      (prisma as any).ticket.count({ where: { status: 'open' } }),
      (prisma as any).ticket.count({ where: { status: 'pending' } }),
      (prisma as any).ticket.count({ where: { status: 'closed' } }),
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
    const row = await (prisma as any).ticket.create({
      data: {
        subject: data.subject,
        description: data.description,
        priority: data.priority ?? 'medium',
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
      if (data.status !== undefined) updateData['status'] = data.status;
      if (data.priority !== undefined) updateData['priority'] = data.priority;
      if (data.assigneeId !== undefined) updateData['assigneeId'] = data.assigneeId;

      const row = await (prisma as any).ticket.update({
        where: { id },
        data: updateData,
        include: INCLUDE,
      });
      return toTicket(row);
    } catch {
      return null;
    }
  }

  async close(id: string): Promise<Ticket | null> {
    return this.update(id, { status: 'closed' });
  }
}

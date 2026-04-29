import { FinanceHistoryEvent } from '@domain/entities/financeHistory';
import { FinanceHistoryFilter, FinanceHistoryRepository } from '@domain/ports/FinanceHistoryRepository';
import { prisma } from '../../database/prisma';

function toEvent(row: any): FinanceHistoryEvent {
  return {
    id: row.id,
    type: row.type,
    description: row.description,
    clientId: row.clientId,
    clientName: row.clientName,
    amount: row.amount ?? null,
    referenceId: row.referenceId ?? null,
    adminId: row.adminId,
    adminName: row.adminName,
    occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
  };
}

export class InMemoryFinanceHistoryRepository implements FinanceHistoryRepository {
  async findAll(filter?: FinanceHistoryFilter): Promise<FinanceHistoryEvent[]> {
    const where: any = {};

    if (filter?.clientId) {
      where.clientId = filter.clientId;
    }
    if (filter?.from) {
      where.occurredAt = { ...where.occurredAt, gte: new Date(filter.from) };
    }
    if (filter?.to) {
      where.occurredAt = { ...where.occurredAt, lte: new Date(filter.to) };
    }

    const rows = await prisma.financeHistoryEvent.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
    });
    return rows.map(toEvent);
  }
}

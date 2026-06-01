import { PaginatedResult } from '@application/dto/pagination';
import {
  ServiceRepository,
  ListServicesQuery,
  ServiceListItem,
  ServiceStats,
} from '@domain/ports/ServiceRepository';
import { prisma } from '../../database/prisma';

function toServiceListItem(row: any): ServiceListItem {
  return {
    id: row.id,
    clientName: row.client?.name ?? '',
    plan: row.plan,
    status: row.status,
    technology: row.technology ?? null,
    startDate: row.startDate instanceof Date ? row.startDate.toISOString() : row.startDate,
  };
}

export class PrismaServiceRepository implements ServiceRepository {
  async list(query: ListServicesQuery): Promise<PaginatedResult<ServiceListItem>> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? query.limit : 25;

    const where: Record<string, unknown> = {};
    if (query.status) where['status'] = query.status;
    if (query.technology) where['technology'] = query.technology;
    if (query.search) {
      where['OR'] = [
        { plan: { contains: query.search, mode: 'insensitive' } },
        { client: { is: { name: { contains: query.search, mode: 'insensitive' } } } },
      ];
    }

    const [rows, total] = await Promise.all([
      (prisma as any).service.findMany({
        where,
        include: { client: { select: { name: true } } },
        orderBy: { startDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      (prisma as any).service.count({ where }),
    ]);

    return { data: rows.map(toServiceListItem), total, page, limit };
  }

  async stats(): Promise<ServiceStats> {
    const groups: Array<{ status: string; _count: { _all: number } }> = await (prisma as any).service.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const g of groups) {
      byStatus[g.status] = g._count._all;
      total += g._count._all;
    }
    return { total, byStatus };
  }
}

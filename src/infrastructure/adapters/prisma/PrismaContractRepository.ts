import { PaginatedResult } from '@application/dto/pagination';
import {
  ContractRepository,
  ListContractsQuery,
  ContractListItem,
  ContractStats,
  UpdateContractLocationInput,
  ContractLocationResult,
} from '@domain/ports/ContractRepository';
import { mapContractStatus } from '@application/use-cases/mapContractStatus';
import { prisma } from '../../database/prisma';

function toContractListItem(row: any): ContractListItem {
  return {
    id: row.id,
    code: row.grContratoId ?? null, // #55 — GR contract code
    clientId: row.clientId,
    clientName: row.client?.name ?? '',
    plan: row.plan,
    status: row.status,
    technology: row.technology ?? null,
    startDate: row.startDate instanceof Date ? row.startDate.toISOString() : row.startDate,
  };
}

export class PrismaContractRepository implements ContractRepository {
  async list(query: ListContractsQuery): Promise<PaginatedResult<ContractListItem>> {
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
      prisma.contract.findMany({
        where,
        include: { client: { select: { name: true } } },
        orderBy: { startDate: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.contract.count({ where }),
    ]);

    return { data: rows.map(toContractListItem), total, page, limit };
  }

  async stats(): Promise<ContractStats> {
    const groups = await prisma.contract.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    // Canonicalize each grouped status before bucketing so legacy raw rows ('Vigente')
    // and new canonical rows ('active') COLLAPSE into the same bucket (defense-in-depth:
    // covers the deploy window + any residual non-canonical rows the backfill missed).
    // Use += so two raw forms that map to the same canonical value sum together.
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const g of groups) {
      const canonical = mapContractStatus(g.status);
      byStatus[canonical] = (byStatus[canonical] ?? 0) + g._count._all;
      total += g._count._all;
    }
    return { total, byStatus };
  }

  async updateName(id: string, name?: string | null): Promise<{ id: string; name: string | null } | null> {
    try {
      // W-3 — undefined is a no-op: omit `name` from data so the column is left untouched.
      // Prisma still returns the (unchanged) row, so the route can echo the current name.
      const data = name === undefined ? {} : { name };
      const row = await (prisma as any).contract.update({
        where: { id },
        data,
        select: { id: true, name: true },
      });
      return { id: row.id, name: row.name ?? null };
    } catch (err: unknown) {
      // P2025 — row to update does not exist; treat as a not-found.
      if ((err as { code?: string })?.code === 'P2025') return null;
      throw err;
    }
  }

  async listDistinctVendedores(): Promise<string[]> {
    const rows = await prisma.contract.findMany({
      where: { vendedor: { not: null } },
      distinct: ['vendedor'],
      select: { vendedor: true },
      orderBy: { vendedor: 'asc' },
    });
    return rows
      .map((r) => r.vendedor)
      .filter((v): v is string => v !== null && v !== '');
  }

  async updateLocation(id: string, data: UpdateContractLocationInput): Promise<ContractLocationResult | null> {
    try {
      // Whitelist: ONLY update gpsLat, gpsLng, gpsPlusCode (Prominense-owned GPS).
      // GR lat/lng are NEVER touched — they remain as-is and continue to sync from GR.
      const row = await (prisma as any).contract.update({
        where: { id },
        data: {
          gpsLat: data.gpsLat,
          gpsLng: data.gpsLng,
          gpsPlusCode: data.gpsPlusCode,
        },
        select: { id: true, gpsLat: true, gpsLng: true, gpsPlusCode: true },
      });
      return {
        id: row.id,
        gpsLat: row.gpsLat ?? null,
        gpsLng: row.gpsLng ?? null,
        gpsPlusCode: row.gpsPlusCode ?? null,
      };
    } catch (err: unknown) {
      // P2025 — record to update not found
      if ((err as { code?: string })?.code === 'P2025') return null;
      throw err;
    }
  }
}

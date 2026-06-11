import { ServiceCatalog } from '@domain/entities/service-catalog';
import { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import { ServiceCatalogNameConflictError } from '@domain/errors/contractServices';
import { prisma } from '../../database/prisma';

function toServiceCatalog(row: any): ServiceCatalog {
  return {
    id: row.id,
    name: row.name,
    label: row.label ?? null,
    active: row.active,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

export class PrismaServiceCatalogRepository implements ServiceCatalogRepository {
  async list(filter?: { active?: boolean }): Promise<ServiceCatalog[]> {
    const where = filter?.active !== undefined ? { active: filter.active } : undefined;
    const rows = await (prisma as any).serviceCatalog.findMany({ where, orderBy: { sortOrder: 'asc' } });
    return rows.map(toServiceCatalog);
  }

  async getById(id: string): Promise<ServiceCatalog | null> {
    const row = await (prisma as any).serviceCatalog.findUnique({ where: { id } });
    return row ? toServiceCatalog(row) : null;
  }

  async getByName(name: string): Promise<ServiceCatalog | null> {
    const rows = await (prisma as any).serviceCatalog.findMany();
    const row = rows.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
    return row ? toServiceCatalog(row) : null;
  }

  async create(data: { name: string; label?: string | null; active?: boolean; sortOrder?: number }): Promise<ServiceCatalog> {
    const row = await (prisma as any).serviceCatalog.create({ data });
    return toServiceCatalog(row);
  }

  async update(id: string, data: Partial<{ name: string; label: string | null; active: boolean; sortOrder: number }>): Promise<ServiceCatalog | null> {
    try {
      const row = await (prisma as any).serviceCatalog.update({ where: { id }, data });
      return toServiceCatalog(row);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      // P2002 — UNIQUE(name) collision from a concurrent rename. Map to the domain
      // conflict error (mirrors PrismaContractServiceRepository.add) so the route → 409,
      // not a bogus 404 from a swallowed-to-null error.
      if (code === 'P2002') throw new ServiceCatalogNameConflictError(String(data.name ?? ''));
      // P2025 — genuine record-not-found. null is the only legitimate null path.
      if (code === 'P2025') return null;
      // Anything else (connection, constraint, etc.) must surface — never silently null.
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).serviceCatalog.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async countInUse(catalogId: string): Promise<number> {
    return (prisma as any).contractService.count({ where: { serviceCatalogId: catalogId } });
  }
}

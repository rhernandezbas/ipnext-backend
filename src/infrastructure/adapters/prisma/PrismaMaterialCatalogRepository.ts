import { MaterialCatalog } from '@domain/entities/material-catalog';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { prisma } from '../../database/prisma';

function toMaterialCatalog(row: any): MaterialCatalog {
  return {
    id: row.id,
    name: row.name,
    label: row.label ?? null,
    unit: row.unit ?? null,
    active: row.active,
    sortOrder: row.sortOrder,
  };
}

export class PrismaMaterialCatalogRepository implements MaterialCatalogRepository {
  async list(): Promise<MaterialCatalog[]> {
    const rows = await (prisma as any).materialCatalog.findMany({ orderBy: { sortOrder: 'asc' } });
    return rows.map(toMaterialCatalog);
  }

  async getById(id: string): Promise<MaterialCatalog | null> {
    const row = await (prisma as any).materialCatalog.findUnique({ where: { id } });
    return row ? toMaterialCatalog(row) : null;
  }

  async getByName(name: string): Promise<MaterialCatalog | null> {
    const rows = await (prisma as any).materialCatalog.findMany();
    const row = rows.find((r: any) => r.name.toLowerCase() === name.toLowerCase());
    return row ? toMaterialCatalog(row) : null;
  }

  async create(data: { name: string; label?: string | null; unit?: string | null; active?: boolean; sortOrder?: number }): Promise<MaterialCatalog> {
    const row = await (prisma as any).materialCatalog.create({ data });
    return toMaterialCatalog(row);
  }

  async update(id: string, data: Partial<{ name: string; label: string | null; unit: string | null; active: boolean; sortOrder: number }>): Promise<MaterialCatalog | null> {
    try {
      const row = await (prisma as any).materialCatalog.update({ where: { id }, data });
      return toMaterialCatalog(row);
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await (prisma as any).materialCatalog.delete({ where: { id } });
      return true;
    } catch {
      return false;
    }
  }

  async countInUse(materialId: string): Promise<number> {
    return (prisma as any).taskMaterialConsumption.count({ where: { materialCatalogId: materialId } });
  }

  async listActiveNames(): Promise<string[]> {
    const rows = await (prisma as any).materialCatalog.findMany({ where: { active: true } });
    return rows.map((r: any) => r.name.toUpperCase());
  }
}

import { MaterialCatalog } from '@domain/entities/material-catalog';
import { MaterialCatalogRepository, LowStockAlertDTO } from '@domain/ports/MaterialCatalogRepository';
import { prisma } from '../../database/prisma';

function toMaterialCatalog(row: any): MaterialCatalog {
  return {
    id: row.id,
    name: row.name,
    label: row.label ?? null,
    unit: row.unit ?? null,
    active: row.active,
    sortOrder: row.sortOrder,
    minStock: row.minStock ?? 0,
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

  async create(data: { name: string; label?: string | null; unit?: string | null; active?: boolean; sortOrder?: number; minStock?: number }): Promise<MaterialCatalog> {
    const row = await (prisma as any).materialCatalog.create({ data });
    return toMaterialCatalog(row);
  }

  async update(id: string, data: Partial<{ name: string; label: string | null; unit: string | null; active: boolean; sortOrder: number; minStock: number }>): Promise<MaterialCatalog | null> {
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

  /**
   * Wave 7 (Capstone) — groupBy materialCatalogId on MaterialStock, SUM qty,
   * join material name/unit, filter minStock > 0 AND SUM < minStock.
   * Single aggregation — no N+1.
   */
  async listLowStock(): Promise<LowStockAlertDTO[]> {
    // Get all materials with minStock > 0
    const materials = await (prisma as any).materialCatalog.findMany({
      where: { minStock: { gt: 0 } },
    });
    if (materials.length === 0) return [];

    const materialIds = materials.map((m: any) => m.id);

    // Aggregate stock qty per material
    const stockAgg = await (prisma as any).materialStock.groupBy({
      by: ['materialCatalogId'],
      where: { materialCatalogId: { in: materialIds } },
      _sum: { qty: true },
    });

    const stockMap = new Map<string, number>();
    for (const row of stockAgg) {
      const qty = row._sum.qty == null ? 0 : Number(row._sum.qty);
      stockMap.set(row.materialCatalogId, qty);
    }

    const alerts: LowStockAlertDTO[] = [];
    for (const mat of materials) {
      const totalQty = stockMap.get(mat.id) ?? 0;
      if (totalQty < mat.minStock) {
        alerts.push({
          materialCatalogId: mat.id,
          name: mat.name,
          label: mat.label ?? null,
          unit: mat.unit ?? null,
          totalQty,
          minStock: mat.minStock,
          deficit: mat.minStock - totalQty,
        });
      }
    }

    return alerts;
  }
}

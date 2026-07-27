import {
  FinanceTechnologyCost,
  FinanceTechnologyCostPatch,
  FinanceTechnologyCostRepository,
} from '@domain/ports/FinanceTechnologyCostRepository';
import { prisma } from '../../database/prisma';

interface CostRow {
  technologyName: string;
  costoVentaArs: unknown; // Prisma.Decimal
  costoInstalacionArs: unknown;
  costoMensualServicioArs: unknown;
  comisionVentaPct: unknown;
  updatedByUserId: string | null;
  updatedAt: Date;
}

function toEntity(row: CostRow): FinanceTechnologyCost {
  return {
    technologyName: row.technologyName,
    costoVentaArs: Number(row.costoVentaArs),
    costoInstalacionArs: Number(row.costoInstalacionArs),
    costoMensualServicioArs: Number(row.costoMensualServicioArs),
    comisionVentaPct: Number(row.comisionVentaPct),
    updatedByUserId: row.updatedByUserId,
    updatedAt: row.updatedAt,
  };
}

/**
 * finance-growth Fase 2 — Prisma adapter for `FinanceTechnologyCost`, keyed
 * by `technologyName` (design.md Data Model, no FK to `ContractTechnology`).
 */
export class PrismaFinanceTechnologyCostRepository implements FinanceTechnologyCostRepository {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get table(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prisma as any).financeTechnologyCost;
  }

  async list(): Promise<FinanceTechnologyCost[]> {
    const rows: CostRow[] = await this.table.findMany({ orderBy: { technologyName: 'asc' } });
    return rows.map(toEntity);
  }

  async getByTechnology(technologyName: string): Promise<FinanceTechnologyCost | null> {
    const row: CostRow | null = await this.table.findUnique({ where: { technologyName } });
    return row ? toEntity(row) : null;
  }

  async upsert(technologyName: string, patch: FinanceTechnologyCostPatch): Promise<FinanceTechnologyCost> {
    const row: CostRow = await this.table.upsert({
      where: { technologyName },
      create: { technologyName, ...patch },
      update: { ...patch },
    });
    return toEntity(row);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  MaterialDeductionSuggestionRepository,
  UpdateMaterialDeductionSuggestionInput,
} from '@domain/ports/MaterialDeductionSuggestionRepository';
import {
  MaterialDeductionSuggestion,
  MaterialDeductionStatus,
  MaterialDeductionResolution,
} from '@domain/entities/material-deduction-suggestion';
import { roundQty } from '@domain/entities/material-stock';
import { Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma';
import { PrismaClientLike } from './PrismaClientLike';

/**
 * Fix M2 — convert qty to Decimal-safe value before writing to Decimal(12,4) column.
 * Mirrors the same helper in PrismaMaterialStockRepository (W1 single-rounding rule).
 */
function dec(value: number): Prisma.Decimal {
  return new Prisma.Decimal(String(roundQty(value)));
}

function toEntity(r: any): MaterialDeductionSuggestion {
  return {
    id: r.id,
    taskMaterialConsumptionId: r.taskMaterialConsumptionId,
    taskId: r.taskId,
    technicianId: r.technicianId ?? null,
    materialCatalogId: r.materialCatalogId,
    qty: typeof r.qty === 'object' && r.qty !== null ? parseFloat(r.qty.toString()) : r.qty,
    technicianLocationId: r.technicianLocationId ?? null,
    status: r.status as MaterialDeductionStatus,
    resolution: (r.resolution ?? null) as MaterialDeductionResolution | null,
    sourceRef: r.sourceRef ?? null,
    deductedMovementId: r.deductedMovementId ?? null,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  };
}

/**
 * Prisma adapter for MaterialDeductionSuggestion (EPIC #38 W6).
 *
 * `create` honors the UNIQUE(taskMaterialConsumptionId) by catching P2002 and
 * returning the existing row — a partial-crash re-stage dedups silently.
 * Tx-scoped: a `Prisma.TransactionClient` can be injected so the confirm
 * updateStatus joins the outer UnitOfWork transaction.
 */
export class PrismaMaterialDeductionSuggestionRepository
  implements MaterialDeductionSuggestionRepository
{
  constructor(private readonly db: PrismaClientLike = prisma) {}

  async create(suggestion: MaterialDeductionSuggestion): Promise<MaterialDeductionSuggestion> {
    try {
      const row = await (this.db as any).materialDeductionSuggestion.create({
        data: {
          id: suggestion.id,
          taskMaterialConsumptionId: suggestion.taskMaterialConsumptionId,
          taskId: suggestion.taskId,
          technicianId: suggestion.technicianId,
          materialCatalogId: suggestion.materialCatalogId,
          qty: dec(suggestion.qty),
          technicianLocationId: suggestion.technicianLocationId,
          status: suggestion.status,
          resolution: suggestion.resolution,
          sourceRef: suggestion.sourceRef,
          deductedMovementId: suggestion.deductedMovementId,
        },
      });
      return toEntity(row);
    } catch (e) {
      // UNIQUE(taskMaterialConsumptionId) collision → return the existing row (L1 dedup).
      if (e && typeof e === 'object' && (e as { code?: string }).code === 'P2002') {
        const existing = await (this.db as any).materialDeductionSuggestion.findUnique({
          where: { taskMaterialConsumptionId: suggestion.taskMaterialConsumptionId },
        });
        if (existing) return toEntity(existing);
      }
      throw e;
    }
  }

  async findById(id: string): Promise<MaterialDeductionSuggestion | null> {
    const row = await (this.db as any).materialDeductionSuggestion.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async findByConsumptionId(consumptionId: string): Promise<MaterialDeductionSuggestion | null> {
    const row = await (this.db as any).materialDeductionSuggestion.findUnique({
      where: { taskMaterialConsumptionId: consumptionId },
    });
    return row ? toEntity(row) : null;
  }

  async listPending(): Promise<MaterialDeductionSuggestion[]> {
    const rows = await (this.db as any).materialDeductionSuggestion.findMany({
      where: { status: { in: ['pending', 'needs_review'] } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toEntity);
  }

  async findBySourceRef(sourceRef: string): Promise<MaterialDeductionSuggestion | null> {
    const row = await (this.db as any).materialDeductionSuggestion.findFirst({
      where: { sourceRef },
    });
    return row ? toEntity(row) : null;
  }

  async updateStatus(
    id: string,
    patch: UpdateMaterialDeductionSuggestionInput,
  ): Promise<MaterialDeductionSuggestion | null> {
    const data: Record<string, unknown> = { status: patch.status };
    if (patch.resolution !== undefined) data.resolution = patch.resolution;
    if (patch.sourceRef !== undefined) data.sourceRef = patch.sourceRef;
    if (patch.deductedMovementId !== undefined) data.deductedMovementId = patch.deductedMovementId;
    try {
      // Fix 4: terminal-state guard. Use updateMany with a status filter so
      // confirmed/discarded rows are never overwritten (0 rows affected → return null).
      // This is the concurrent-race safety net; the L1 guard in execute() catches
      // the common re-click before this point.
      const result = await (this.db as any).materialDeductionSuggestion.updateMany({
        where: { id, status: { in: ['pending', 'needs_review'] } },
        data,
      });
      if (result.count === 0) return null;
      // Re-fetch to return the up-to-date entity.
      const row = await (this.db as any).materialDeductionSuggestion.findUnique({ where: { id } });
      return row ? toEntity(row) : null;
    } catch {
      return null;
    }
  }
}

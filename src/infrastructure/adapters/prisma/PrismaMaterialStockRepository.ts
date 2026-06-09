import { MaterialStockRepository } from '@domain/ports/MaterialStockRepository';
import { MaterialStock, roundQty } from '@domain/entities/material-stock';
import { InsufficientStockError } from '@domain/errors/inventory';
import { prisma } from '../../database/prisma';
import { Prisma } from '@prisma/client';
import { PrismaClientLike } from './PrismaClientLike';
import { randomUUID } from 'crypto';

/**
 * Fix M2 — convert a JS number to a Decimal-safe value rounded to the column
 * scale (Decimal(12,4)) BEFORE it reaches Postgres, so binary-float artifacts
 * (e.g. 0.1+0.2 = 0.30000000000000004) never land in the column.
 *
 * Rounding goes through the domain `roundQty` (THE single rule) so this adapter,
 * `PrismaInventoryMovementRepository` and the in-memory adapters land
 * bit-identical balances. `roundQty` IS `Number(n.toFixed(4))`, so
 * `String(roundQty(value))` is the exact 4-decimal value Postgres would store.
 */
function dec(value: number): Prisma.Decimal {
  return new Prisma.Decimal(String(roundQty(value)));
}

type Row = {
  id: string;
  materialCatalogId: string;
  locationId: string;
  qty: unknown;
};

/** Normalize a Prisma Decimal | number | null at the adapter boundary → number. */
function toNum(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  return Number(v);
}

function toEntity(r: Row): MaterialStock {
  return {
    id: r.id,
    materialCatalogId: r.materialCatalogId,
    locationId: r.locationId,
    qty: toNum(r.qty),
  };
}

export class PrismaMaterialStockRepository implements MaterialStockRepository {
  /**
   * Fix W-DimA — accept an injected client (default: global `prisma`) so this
   * repo can join an outer UnitOfWork transaction, matching its 4 sibling
   * inventory repos. No behavior change when constructed without an argument.
   */
  constructor(private readonly db: PrismaClientLike = prisma) {}

  async findByMaterialAndLocation(
    materialCatalogId: string,
    locationId: string,
  ): Promise<MaterialStock | null> {
    const row = await this.db.materialStock.findUnique({
      where: { materialCatalogId_locationId: { materialCatalogId, locationId } },
    });
    return row ? toEntity(row) : null;
  }

  async upsert(stock: MaterialStock): Promise<MaterialStock> {
    const row = await this.db.materialStock.upsert({
      where: {
        materialCatalogId_locationId: {
          materialCatalogId: stock.materialCatalogId,
          locationId: stock.locationId,
        },
      },
      update: { qty: dec(stock.qty) },
      create: {
        id: stock.id || randomUUID(),
        materialCatalogId: stock.materialCatalogId,
        locationId: stock.locationId,
        qty: dec(stock.qty),
      },
    });
    return toEntity(row);
  }

  async decrement(
    materialCatalogId: string,
    locationId: string,
    amount: number,
  ): Promise<MaterialStock> {
    // Atomic conditional decrement (Fix #1/#2): the `qty >= amount` guard lives
    // in the WHERE clause, so there is NO read-then-write TOCTOU window (safe
    // under READ COMMITTED). On count===0 the row is missing or insufficient →
    // throw; never create a negative-qty row.
    // Fix M2: both the gte guard and the decrement are Decimal-safe.
    const amountDec = dec(amount);
    const result = await this.db.materialStock.updateMany({
      where: { materialCatalogId, locationId, qty: { gte: amountDec } },
      data: { qty: { decrement: amountDec } },
    });
    if (result.count === 0) {
      const existing = await this.db.materialStock.findUnique({
        where: { materialCatalogId_locationId: { materialCatalogId, locationId } },
      });
      const available = toNum(existing?.qty);
      throw new InsufficientStockError(materialCatalogId, available, amount);
    }
    const row = await this.db.materialStock.findUnique({
      where: { materialCatalogId_locationId: { materialCatalogId, locationId } },
    });
    return toEntity(row as Row);
  }

  async increment(
    materialCatalogId: string,
    locationId: string,
    amount: number,
  ): Promise<MaterialStock> {
    const amountDec = dec(amount);
    const row = await this.db.materialStock.upsert({
      where: { materialCatalogId_locationId: { materialCatalogId, locationId } },
      update: { qty: { increment: amountDec } },
      create: { id: randomUUID(), materialCatalogId, locationId, qty: amountDec },
    });
    return toEntity(row);
  }
}

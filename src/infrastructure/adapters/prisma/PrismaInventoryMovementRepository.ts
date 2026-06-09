import {
  InventoryMovementRepository,
  RecordMovementInput,
} from '@domain/ports/InventoryMovementRepository';
import { createInventoryMovement, InventoryMovement } from '@domain/entities/inventory-movement';
import { computeAssetEffect } from '@domain/entities/inventory-asset-effect';
import { roundQty } from '@domain/entities/material-stock';
import { InsufficientStockError } from '@domain/errors/inventory';
import { prisma } from '../../database/prisma';
import { Prisma } from '@prisma/client';
import { PrismaClientLike } from './PrismaClientLike';
import { randomUUID } from 'crypto';

/** Normalize a Prisma Decimal | number | null at the adapter boundary → number | null. */
function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber();
  }
  return Number(v);
}

/**
 * Fix M2 — convert a JS number to a Decimal-safe value rounded to the column
 * scale (Decimal(12,4)) BEFORE it reaches Postgres, so binary-float artifacts
 * (e.g. 0.1+0.2 = 0.30000000000000004) never land in the qty column.
 *
 * Rounding goes through the domain `roundQty` (THE single rule) so this adapter
 * and the in-memory adapters land bit-identical balances. `roundQty` IS
 * `Number(n.toFixed(4))`, so `String(roundQty(value))` is the exact 4-decimal
 * value Postgres would store.
 */
function dec(value: number): Prisma.Decimal {
  return new Prisma.Decimal(String(roundQty(value)));
}

type Row = {
  id: string;
  type: string;
  assetId: string | null;
  materialCatalogId: string | null;
  qty: unknown;
  fromLocationId: string | null;
  toLocationId: string | null;
  taskId: string | null;
  technicianId: string | null;
  source: string;
  note: string | null;
  occurredAt: Date;
};

function toEntity(r: Row): InventoryMovement {
  return createInventoryMovement({
    id: r.id,
    type: r.type as InventoryMovement['type'],
    assetId: r.assetId,
    materialCatalogId: r.materialCatalogId,
    qty: toNum(r.qty),
    fromLocationId: r.fromLocationId,
    toLocationId: r.toLocationId,
    taskId: r.taskId,
    technicianId: r.technicianId,
    source: r.source,
    note: r.note,
    occurredAt: r.occurredAt.toISOString(),
  });
}

/**
 * Prisma adapter del ledger primitive. `record()` envuelve la inserción del
 * movimiento Y la actualización del balance materializado en un único
 * `prisma.$transaction` (atómico, all-or-nothing). El guard de stock negativo
 * lee la qty actual DENTRO de la transacción y lanza InsufficientStockError
 * para hacer rollback antes de persistir el movimiento.
 */
export class PrismaInventoryMovementRepository implements InventoryMovementRepository {
  /**
   * When `db` is the root client (default) `record()` opens its own
   * `$transaction`. When `db` is already a `Prisma.TransactionClient` (injected
   * by the UnitOfWork, Fix #1/#3), it RUNS DIRECTLY on it — no nested
   * transaction — so the ledger write joins the outer confirm/replace tx and
   * rolls back with it.
   */
  constructor(private readonly db: PrismaClientLike = prisma) {}

  /** True when this repo already runs inside an outer transaction (no $transaction). */
  private get isTxScoped(): boolean {
    return typeof (this.db as { $transaction?: unknown }).$transaction !== 'function';
  }

  async record(input: RecordMovementInput): Promise<InventoryMovement> {
    // Validate shape (XOR + qty>0) BEFORE opening the transaction.
    const movement = createInventoryMovement({
      id: randomUUID(),
      type: input.type,
      assetId: input.assetId ?? null,
      materialCatalogId: input.materialCatalogId ?? null,
      qty: input.qty ?? null,
      fromLocationId: input.fromLocationId ?? null,
      toLocationId: input.toLocationId ?? null,
      taskId: input.taskId ?? null,
      technicianId: input.technicianId ?? null,
      source: input.source,
      note: input.note ?? null,
      occurredAt: input.occurredAt ?? null,
      status: input.status ?? null,
    });

    const body = async (tx: Prisma.TransactionClient) => {
      if (movement.assetId) {
        await this.applyAssetEffect(tx, movement);
      } else {
        await this.applyMaterialEffect(tx, movement);
      }
      return tx.inventoryMovement.create({
        data: {
          id: movement.id,
          type: movement.type,
          assetId: movement.assetId,
          materialCatalogId: movement.materialCatalogId,
          // Fix M2: the ledger qty column is Decimal(12,4) too — write Decimal-safe.
          qty: movement.qty == null ? null : dec(movement.qty),
          fromLocationId: movement.fromLocationId,
          toLocationId: movement.toLocationId,
          taskId: movement.taskId,
          technicianId: movement.technicianId,
          source: movement.source,
          note: movement.note,
          occurredAt: new Date(movement.occurredAt),
        },
      });
    };

    const row = this.isTxScoped
      ? await body(this.db as Prisma.TransactionClient)
      : await (this.db as typeof prisma).$transaction(body);

    return toEntity(row);
  }

  private async applyAssetEffect(
    tx: Prisma.TransactionClient,
    mv: InventoryMovement,
  ): Promise<void> {
    // SINGLE source of truth — same pure function the in-memory adapter uses (Fix #3).
    const data = computeAssetEffect(mv);
    if (Object.keys(data).length > 0) {
      await tx.inventoryAsset.update({ where: { id: mv.assetId! }, data });
    }
  }

  private async applyMaterialEffect(
    tx: Prisma.TransactionClient,
    mv: InventoryMovement,
  ): Promise<void> {
    const materialCatalogId = mv.materialCatalogId!;
    const qty = mv.qty!;
    // Fix M2: every write goes through `dec()` → Decimal(12,4)-safe, no float drift.
    const increment = (locationId: string, value: number) =>
      tx.materialStock.upsert({
        where: { materialCatalogId_locationId: { materialCatalogId, locationId } },
        update: { qty: { increment: dec(value) } },
        create: { id: randomUUID(), materialCatalogId, locationId, qty: dec(value) },
      });
    const setQty = (locationId: string, value: number) =>
      tx.materialStock.upsert({
        where: { materialCatalogId_locationId: { materialCatalogId, locationId } },
        update: { qty: dec(value) },
        create: { id: randomUUID(), materialCatalogId, locationId, qty: dec(value) },
      });

    switch (mv.type) {
      case 'CONSUME':
      case 'ISSUE': {
        await this.atomicDecrement(tx, materialCatalogId, mv.fromLocationId!, qty);
        break;
      }
      case 'TRANSFER': {
        await this.atomicDecrement(tx, materialCatalogId, mv.fromLocationId!, qty);
        await increment(mv.toLocationId!, qty);
        break;
      }
      case 'ADJUST': {
        await setQty(mv.toLocationId!, qty);
        break;
      }
      default: {
        if (mv.toLocationId) await increment(mv.toLocationId, qty);
        break;
      }
    }
  }

  /**
   * Atomic conditional decrement (Fix #1/#2). A single `updateMany` with
   * `qty >= amount` in the WHERE eliminates the read-then-write TOCTOU window
   * (safe under READ COMMITTED). If `count === 0` the row is missing or has
   * insufficient stock → throw InsufficientStockError; never creates a
   * negative-qty row.
   */
  private async atomicDecrement(
    tx: Prisma.TransactionClient,
    materialCatalogId: string,
    locationId: string,
    amount: number,
  ): Promise<void> {
    const amountDec = dec(amount);
    const result = await tx.materialStock.updateMany({
      where: { materialCatalogId, locationId, qty: { gte: amountDec } },
      data: { qty: { decrement: amountDec } },
    });
    if (result.count === 0) {
      const existing = await tx.materialStock.findUnique({
        where: { materialCatalogId_locationId: { materialCatalogId, locationId } },
      });
      const available = toNum(existing?.qty) ?? 0;
      throw new InsufficientStockError(materialCatalogId, available, amount);
    }
  }

  async listByAsset(assetId: string): Promise<InventoryMovement[]> {
    const rows = await this.db.inventoryMovement.findMany({
      where: { assetId },
      orderBy: { occurredAt: 'asc' },
    });
    return rows.map(toEntity);
  }
}

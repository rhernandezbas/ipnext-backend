import { MaterialStockRepository } from '@domain/ports/MaterialStockRepository';
import { MaterialStock, roundQty } from '@domain/entities/material-stock';
import { InsufficientStockError } from '@domain/errors/inventory';
import { randomUUID } from 'crypto';

export class InMemoryMaterialStockRepository implements MaterialStockRepository {
  readonly store = new Map<string, MaterialStock>();

  private key(materialCatalogId: string, locationId: string): string {
    return `${materialCatalogId}::${locationId}`;
  }

  async findByMaterialAndLocation(
    materialCatalogId: string,
    locationId: string,
  ): Promise<MaterialStock | null> {
    const s = this.store.get(this.key(materialCatalogId, locationId));
    return s ? { ...s } : null;
  }

  async listByLocation(locationId: string): Promise<MaterialStock[]> {
    return Array.from(this.store.values())
      .filter((s) => s.locationId === locationId)
      .map((s) => ({ ...s }));
  }

  async upsert(stock: MaterialStock): Promise<MaterialStock> {
    const k = this.key(stock.materialCatalogId, stock.locationId);
    const existing = this.store.get(k);
    // roundQty mirrors Prisma's Decimal(12,4) `dec()` so both adapters store the
    // same value for sub-precision inputs (Fix M2/Wave4).
    const row: MaterialStock = existing
      ? { ...existing, qty: roundQty(stock.qty) }
      : { ...stock, id: stock.id || randomUUID(), qty: roundQty(stock.qty) };
    this.store.set(k, row);
    return { ...row };
  }

  async decrement(
    materialCatalogId: string,
    locationId: string,
    amount: number,
  ): Promise<MaterialStock> {
    const k = this.key(materialCatalogId, locationId);
    const existing = this.store.get(k);
    const current = existing?.qty ?? 0;
    const next = current - amount;
    // Guard BEFORE mutating — never leaves a negative balance. A missing row has
    // current=0, so any qty>0 decrement throws here. This mirrors the Prisma
    // "never create on decrement" invariant: by the time we reach the write below
    // `existing` is always defined (Fix L1 — removed the unreachable create branch).
    if (next < 0) throw new InsufficientStockError(materialCatalogId, current, amount);
    // roundQty matches Prisma's Decimal(12,4) write boundary (Fix M2/Wave4).
    const row: MaterialStock = { ...existing!, qty: roundQty(next) };
    this.store.set(k, row);
    return { ...row };
  }

  async increment(
    materialCatalogId: string,
    locationId: string,
    amount: number,
  ): Promise<MaterialStock> {
    const k = this.key(materialCatalogId, locationId);
    const existing = this.store.get(k);
    // roundQty matches Prisma's Decimal(12,4) write boundary (Fix M2/Wave4).
    const row: MaterialStock = existing
      ? { ...existing, qty: roundQty(existing.qty + amount) }
      : { id: randomUUID(), materialCatalogId, locationId, qty: roundQty(amount) };
    this.store.set(k, row);
    return { ...row };
  }
}

import { InventoryMovementRepository } from '@domain/ports/InventoryMovementRepository';
import { MaterialCatalogRepository } from '@domain/ports/MaterialCatalogRepository';
import { MaterialStockRepository } from '@domain/ports/MaterialStockRepository';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { roundQty } from '@domain/entities/material-stock';
import {
  InvalidQuantityError,
  MaterialNotFoundError,
} from '@domain/errors/inventory';

export interface AddMaterialToDepotInput {
  materialCatalogId: string;
  qty: number;
  note?: string | null;
}

export interface AddMaterialToDepotOutput {
  ok: true;
  materialCatalogId: string;
  newQty: number;
}

/**
 * AddMaterialToDepot — operator-driven manual stock entry for consumable materials
 * (EPIC #38 follow-up). Increments the depot MaterialStock balance and records an
 * ADJUST ledger movement atomically.
 *
 * Semantics (FIX W1 cardinal — DELTA-additive ADJUST):
 *   - NO pre-read of the current balance. The use case passes the raw DELTA (input.qty)
 *     directly to movements.record() as the movement qty.
 *   - Both adapters apply ADJUST(material) via `increment` (additive upsert), so two
 *     concurrent loads over the same base both commit — no lost-update window.
 *   - The ledger row carries the DELTA, not the running total. "ADJUST 5" means the
 *     operator loaded 5 units; the resulting balance is old+5.
 *   - `roundQty` applied to input qty (W1 rule).
 *   - qty must be > 0 → 400 INVALID_QUANTITY.
 *   - materialCatalogId must exist → 404 MATERIAL_NOT_FOUND.
 *   - `newQty` in the response: read-after-write from MaterialStock (acceptable;
 *     the increment already committed).
 */
export class AddMaterialToDepot {
  constructor(
    private readonly movements: InventoryMovementRepository,
    private readonly materialCatalog: MaterialCatalogRepository,
    private readonly materialStock: MaterialStockRepository,
    private readonly resolveDepot: ResolveDepotLocation,
  ) {}

  async execute(input: AddMaterialToDepotInput): Promise<AddMaterialToDepotOutput> {
    // 1) Quantity guard.
    const qty = roundQty(input.qty);
    if (qty <= 0) throw new InvalidQuantityError();

    // 2) Material catalog lookup — 404 if unknown.
    const material = await this.materialCatalog.getById(input.materialCatalogId);
    if (!material) throw new MaterialNotFoundError(input.materialCatalogId);

    // 3) Resolve depot (find-or-create idempotent).
    const depot = await this.resolveDepot.execute('DEPOSITO');

    // 4) Record the ADJUST movement with the raw DELTA (no pre-read).
    //    Both adapters apply ADJUST(material) via `increment` — the ledger row qty IS
    //    the delta. This eliminates the lost-update window under concurrency (W1 cardinal).
    //    Note: createInventoryMovement requires ADJUST to have a non-empty note.
    await this.movements.record({
      type: 'ADJUST',
      materialCatalogId: input.materialCatalogId,
      qty,
      toLocationId: depot.id,
      source: 'MANUAL',
      note: (input.note && input.note.trim()) ? input.note.trim() : 'Carga manual de material al depósito',
    });

    // 5) Read the resulting balance (read-after-write — the increment already committed).
    const afterStock = await this.materialStock.findByMaterialAndLocation(
      input.materialCatalogId,
      depot.id,
    );
    const newQty = roundQty(afterStock?.qty ?? qty);

    return {
      ok: true,
      materialCatalogId: input.materialCatalogId,
      newQty,
    };
  }
}

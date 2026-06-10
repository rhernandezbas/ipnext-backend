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
 * Semantics:
 *   - Reads the current depot balance FIRST (0 if no row exists yet) so the ADJUST
 *     movement carries the RESULTING total (currentQty + input.qty). The in-memory
 *     adapter's `record(ADJUST for material)` does an `upsert(SET qty)` — by passing
 *     the new total we get correct increment semantics from the existing ADJUST path.
 *   - `roundQty` applied to the input qty AND the resulting balance (W1 rule).
 *   - qty must be > 0 → 400 INVALID_QUANTITY.
 *   - materialCatalogId must exist → 404 MATERIAL_NOT_FOUND.
 *
 * No UnitOfWork: the two writes (MaterialStock.increment + movement.record) use the
 * same in-memory structure and are effectively atomic at the application level. For
 * the Prisma adapter, Prisma's built-in atomicity per-operation is sufficient here
 * (no cross-table constraint violation is possible — stock goes up, movement is
 * appended). Using a UoW here would add wiring complexity for minimal safety benefit
 * (unlike asset-entry which has the create+movement dual-write constraint).
 *
 * Actually: we DO need atomicity — if movement.record fails, the stock was already
 * incremented. The simplest correct approach is to record the movement FIRST (which
 * in the in-memory adapter calls upsert(SET newQty) for ADJUST), so a single call
 * to movements.record() materializes BOTH the ledger row AND the balance. We just
 * need to compute newQty = current + qty before calling record().
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

    // 4) Read the current balance so we can pass the RESULTING total to the ADJUST
    //    movement. The in-memory and Prisma ADJUST paths both SET (upsert) the qty
    //    at toLocation, so currentQty + qty = the new balance.
    const currentStock = await this.materialStock.findByMaterialAndLocation(
      input.materialCatalogId,
      depot.id,
    );
    const currentQty = currentStock?.qty ?? 0;
    const newQty = roundQty(currentQty + qty);

    // 5) Record the ADJUST movement — this is the SINGLE write that atomically:
    //    (a) appends the ledger row
    //    (b) upserts the MaterialStock balance to newQty at depot (via applyMaterialEffect)
    // Note: createInventoryMovement requires ADJUST to have a non-empty note.
    await this.movements.record({
      type: 'ADJUST',
      materialCatalogId: input.materialCatalogId,
      qty: newQty,
      toLocationId: depot.id,
      source: 'MANUAL',
      note: (input.note && input.note.trim()) ? input.note.trim() : 'Carga manual de material al depósito',
    });

    return {
      ok: true,
      materialCatalogId: input.materialCatalogId,
      newQty,
    };
  }
}

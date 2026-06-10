import { AddMaterialToDepot } from '@application/use-cases/AddMaterialToDepot';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import {
  InvalidQuantityError,
  MaterialNotFoundError,
} from '@domain/errors/inventory';

async function setup() {
  const assets = new InMemoryInventoryAssetRepository();
  const materialStock = new InMemoryMaterialStockRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, materialStock);
  const locations = new InMemoryStockLocationRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  const materialCatalog = new InMemoryMaterialCatalogRepository();
  const resolveDepot = new ResolveDepotLocation(locations);

  const cable = await materialCatalog.create({ name: 'CABLE_UTP', label: 'Cable UTP', unit: 'm', active: true, sortOrder: 0 });

  const useCase = new AddMaterialToDepot(movements, materialCatalog, materialStock, resolveDepot);
  const getDepot = new GetDepotStock(locations, assets, materialStock, deviceTypes, materialCatalog);

  return { movements, locations, materialStock, materialCatalog, useCase, getDepot, cable };
}

describe('AddMaterialToDepot', () => {
  it('happy path — MaterialStock depot += qty, ADJUST in ledger, newQty correct', async () => {
    const { useCase, movements, locations, materialStock, cable } = await setup();

    const result = await useCase.execute({ materialCatalogId: cable.id, qty: 100, note: 'initial load' });

    expect(result.ok).toBe(true);
    expect(result.materialCatalogId).toBe(cable.id);
    expect(result.newQty).toBe(100);

    // ADJUST movement in ledger
    const depot = await locations.findByCode('DEPOSITO');
    expect(depot).not.toBeNull();
    expect(movements.movements).toHaveLength(1);
    expect(movements.movements[0].type).toBe('ADJUST');
    expect(movements.movements[0].materialCatalogId).toBe(cable.id);
    expect(movements.movements[0].toLocationId).toBe(depot!.id);
    expect(movements.movements[0].source).toBe('MANUAL');

    // MaterialStock updated
    const stock = await materialStock.findByMaterialAndLocation(cable.id, depot!.id);
    expect(stock?.qty).toBe(100);
  });

  it('second entry adds to existing balance', async () => {
    const { useCase, materialStock, locations, cable } = await setup();

    await useCase.execute({ materialCatalogId: cable.id, qty: 100 });
    const result2 = await useCase.execute({ materialCatalogId: cable.id, qty: 50 });

    expect(result2.newQty).toBe(150);
    const depot = await locations.findByCode('DEPOSITO');
    const stock = await materialStock.findByMaterialAndLocation(cable.id, depot!.id);
    expect(stock?.qty).toBe(150);
  });

  it('visible via GetDepotStock after entry', async () => {
    const { useCase, getDepot, cable } = await setup();

    await useCase.execute({ materialCatalogId: cable.id, qty: 42 });

    const stock = await getDepot.execute();
    expect(stock.materials).toHaveLength(1);
    expect(stock.materials[0].materialCatalogId).toBe(cable.id);
    expect(stock.materials[0].qty).toBe(42);
  });

  it('float artifact qty (0.1+0.2) → rounded to 4 decimals', async () => {
    const { useCase, materialStock, locations, cable } = await setup();

    const result = await useCase.execute({ materialCatalogId: cable.id, qty: 0.1 + 0.2 });

    expect(result.newQty).toBe(0.3);
    const depot = await locations.findByCode('DEPOSITO');
    const stock = await materialStock.findByMaterialAndLocation(cable.id, depot!.id);
    expect(stock?.qty).toBe(0.3);
  });

  it('qty = 0 → InvalidQuantityError (400)', async () => {
    const { useCase, cable } = await setup();

    await expect(
      useCase.execute({ materialCatalogId: cable.id, qty: 0 }),
    ).rejects.toBeInstanceOf(InvalidQuantityError);
  });

  it('qty < 0 → InvalidQuantityError (400)', async () => {
    const { useCase, cable } = await setup();

    await expect(
      useCase.execute({ materialCatalogId: cable.id, qty: -5 }),
    ).rejects.toBeInstanceOf(InvalidQuantityError);
  });

  it('unknown materialCatalogId → MaterialNotFoundError (404)', async () => {
    const { useCase } = await setup();

    await expect(
      useCase.execute({ materialCatalogId: 'unknown-mat', qty: 10 }),
    ).rejects.toBeInstanceOf(MaterialNotFoundError);
  });

  // ── FIX 1: ADJUST is DELTA-additive ───────────────────────────────────────

  it('FIX1a — ledger row qty equals the DELTA loaded, not the running total', async () => {
    // Seed an existing balance of 10, then load 5 more.
    // The ADJUST movement qty MUST be 5 (the delta), not 15.
    const { useCase, movements, materialStock, locations, cable } = await setup();

    // Seed balance to 10 by doing an initial load.
    await useCase.execute({ materialCatalogId: cable.id, qty: 10 });

    // Second load: delta = 5.
    await useCase.execute({ materialCatalogId: cable.id, qty: 5 });

    // There should be 2 ledger rows.
    expect(movements.movements).toHaveLength(2);
    // The second row must carry qty=5 (the delta), not 15.
    expect(movements.movements[1].qty).toBe(5);
    // But the actual balance must be 15.
    const depot = await locations.findByCode('DEPOSITO');
    const stock = await materialStock.findByMaterialAndLocation(cable.id, depot!.id);
    expect(stock?.qty).toBe(15);
  });

  it('FIX1b — two sequential loads +5 +3 over base 10 → balance 18', async () => {
    const { useCase, materialStock, locations, cable } = await setup();

    await useCase.execute({ materialCatalogId: cable.id, qty: 10 });
    await useCase.execute({ materialCatalogId: cable.id, qty: 5 });
    const r3 = await useCase.execute({ materialCatalogId: cable.id, qty: 3 });

    expect(r3.newQty).toBe(18);
    const depot = await locations.findByCode('DEPOSITO');
    const stock = await materialStock.findByMaterialAndLocation(cable.id, depot!.id);
    expect(stock?.qty).toBe(18);
  });

  it('FIX1c — concurrent loads (Promise.all) both committed, balance is additive', async () => {
    // Both in-memory calls execute "simultaneously" — final balance must be sum of both.
    const { useCase, materialStock, locations, cable } = await setup();

    // Seed base = 10.
    await useCase.execute({ materialCatalogId: cable.id, qty: 10 });

    // Fire both concurrently.
    const [r1, r2] = await Promise.all([
      useCase.execute({ materialCatalogId: cable.id, qty: 5 }),
      useCase.execute({ materialCatalogId: cable.id, qty: 3 }),
    ]);

    // Both must succeed and their deltas must both appear in the balance.
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const depot = await locations.findByCode('DEPOSITO');
    const stock = await materialStock.findByMaterialAndLocation(cable.id, depot!.id);
    // 10 + 5 + 3 = 18; order doesn't matter since additive ops commute.
    expect(stock?.qty).toBe(18);
  });
});

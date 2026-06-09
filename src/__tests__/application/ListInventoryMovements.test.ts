import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { ListInventoryMovements } from '@application/use-cases/ListInventoryMovements';
import { createStockLocation } from '@domain/entities/stock-location';
import { createMaterialStock } from '@domain/entities/material-stock';

/**
 * SCEN-MOV-1: paging defaults (25/page, total reflects all)
 * SCEN-MOV-2: page 2 returns remaining
 * SCEN-MOV-3: filter by type
 * SCEN-MOV-4: filter by locationId (from OR to)
 * SCEN-MOV-5: filter by date range
 * SCEN-MOV-6: combined filters
 * SCEN-MOV-7: empty results
 */

function makeRepos() {
  const assets = new InMemoryInventoryAssetRepository();
  const stockRepo = new InMemoryMaterialStockRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, stockRepo);
  const materialCatalog = new InMemoryMaterialCatalogRepository();
  const locations = new InMemoryStockLocationRepository();
  return { movements, assets, stockRepo, materialCatalog, locations };
}

async function seedLocations(locations: InMemoryStockLocationRepository) {
  await locations.create(createStockLocation({ id: 'loc-depot', type: 'DEPOSITO', code: 'DEPOSITO' }));
  await locations.create(createStockLocation({ id: 'loc-client', type: 'CLIENTE', contractId: 'c-1' }));
}

describe('ListInventoryMovements', () => {
  it('SCEN-MOV-7: returns empty result when no movements', async () => {
    const { movements, materialCatalog, locations } = makeRepos();
    const uc = new ListInventoryMovements(movements, materialCatalog, locations);

    const result = await uc.execute({}, 1, 25);

    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(25);
  });

  it('SCEN-MOV-1: paging defaults — returns 25 of 30, total=30', async () => {
    const { movements, stockRepo, materialCatalog, locations } = makeRepos();

    // Seed a DEPOSITO location and material
    await locations.create(createStockLocation({ id: 'loc-depot', type: 'DEPOSITO', code: 'DEPOSITO' }));
    const mat = await materialCatalog.create({ name: 'CABLE', sortOrder: 0 });
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-depot', qty: 10000 });

    // Record 30 CONSUME movements
    for (let i = 0; i < 30; i++) {
      await movements.record({
        type: 'CONSUME',
        materialCatalogId: mat.id,
        qty: 1,
        fromLocationId: 'loc-depot',
        source: 'TEST',
        occurredAt: new Date(2026, 4, i + 1).toISOString(),
      });
    }

    const uc = new ListInventoryMovements(movements, materialCatalog, locations);
    const result = await uc.execute({}, 1, 25);

    expect(result.total).toBe(30);
    expect(result.items).toHaveLength(25);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(25);
  });

  it('SCEN-MOV-2: page 2 returns remaining 5 of 30', async () => {
    const { movements, stockRepo, materialCatalog, locations } = makeRepos();

    await locations.create(createStockLocation({ id: 'loc-depot', type: 'DEPOSITO', code: 'DEPOSITO' }));
    const mat = await materialCatalog.create({ name: 'CABLE', sortOrder: 0 });
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-depot', qty: 10000 });

    for (let i = 0; i < 30; i++) {
      await movements.record({
        type: 'CONSUME',
        materialCatalogId: mat.id,
        qty: 1,
        fromLocationId: 'loc-depot',
        source: 'TEST',
        occurredAt: new Date(2026, 4, i + 1).toISOString(),
      });
    }

    const uc = new ListInventoryMovements(movements, materialCatalog, locations);
    const result = await uc.execute({}, 2, 25);

    expect(result.total).toBe(30);
    expect(result.items).toHaveLength(5);
    expect(result.page).toBe(2);
  });

  it('SCEN-MOV-3: filter by type returns only matching type', async () => {
    const { movements, stockRepo, materialCatalog, locations } = makeRepos();

    await locations.create(createStockLocation({ id: 'loc-depot', type: 'DEPOSITO', code: 'DEPOSITO' }));
    await locations.create(createStockLocation({ id: 'loc-client', type: 'CLIENTE', contractId: 'c-1' }));
    const mat = await materialCatalog.create({ name: 'CABLE', sortOrder: 0 });
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-depot', qty: 1000 });
    await stockRepo.upsert({ id: 'ms2', materialCatalogId: mat.id, locationId: 'loc-client', qty: 1000 });

    // 3 CONSUME movements
    for (let i = 0; i < 3; i++) {
      await movements.record({ type: 'CONSUME', materialCatalogId: mat.id, qty: 1, fromLocationId: 'loc-depot', source: 'TEST' });
    }
    // 2 RETURN movements
    for (let i = 0; i < 2; i++) {
      await movements.record({ type: 'RETURN', materialCatalogId: mat.id, qty: 1, toLocationId: 'loc-depot', source: 'TEST' });
    }

    const uc = new ListInventoryMovements(movements, materialCatalog, locations);
    const result = await uc.execute({ type: 'CONSUME' }, 1, 25);

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
    expect(result.items.every((i) => i.type === 'CONSUME')).toBe(true);
  });

  it('SCEN-MOV-4: filter by locationId returns movements where fromLocationId OR toLocationId matches', async () => {
    const { movements, stockRepo, materialCatalog, locations } = makeRepos();

    await locations.create(createStockLocation({ id: 'loc-depot', type: 'DEPOSITO', code: 'DEPOSITO' }));
    await locations.create(createStockLocation({ id: 'loc-L1', type: 'CLIENTE', contractId: 'c-1' }));
    const mat = await materialCatalog.create({ name: 'CABLE', sortOrder: 0 });
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-depot', qty: 1000 });
    await stockRepo.upsert({ id: 'ms2', materialCatalogId: mat.id, locationId: 'loc-L1', qty: 1000 });

    // 2 movements from loc-L1
    for (let i = 0; i < 2; i++) {
      await movements.record({ type: 'CONSUME', materialCatalogId: mat.id, qty: 1, fromLocationId: 'loc-L1', source: 'TEST' });
    }
    // 1 movement to loc-L1
    await movements.record({ type: 'RETURN', materialCatalogId: mat.id, qty: 1, toLocationId: 'loc-L1', source: 'TEST' });
    // Other movements not involving loc-L1
    await movements.record({ type: 'CONSUME', materialCatalogId: mat.id, qty: 1, fromLocationId: 'loc-depot', source: 'TEST' });

    const uc = new ListInventoryMovements(movements, materialCatalog, locations);
    const result = await uc.execute({ locationId: 'loc-L1' }, 1, 25);

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
  });

  it('SCEN-MOV-5: filter by date range returns only movements within range', async () => {
    const { movements, stockRepo, materialCatalog, locations } = makeRepos();

    await locations.create(createStockLocation({ id: 'loc-depot', type: 'DEPOSITO', code: 'DEPOSITO' }));
    const mat = await materialCatalog.create({ name: 'CABLE', sortOrder: 0 });
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-depot', qty: 1000 });

    // May 1, 2026 (2 movements)
    for (let i = 0; i < 2; i++) {
      await movements.record({ type: 'CONSUME', materialCatalogId: mat.id, qty: 1, fromLocationId: 'loc-depot', source: 'TEST', occurredAt: '2026-05-01T00:00:00.000Z' });
    }
    // June 1–30, 2026 (3 movements)
    for (let i = 0; i < 3; i++) {
      await movements.record({ type: 'CONSUME', materialCatalogId: mat.id, qty: 1, fromLocationId: 'loc-depot', source: 'TEST', occurredAt: '2026-06-15T00:00:00.000Z' });
    }
    // July 1, 2026 (1 movement)
    await movements.record({ type: 'CONSUME', materialCatalogId: mat.id, qty: 1, fromLocationId: 'loc-depot', source: 'TEST', occurredAt: '2026-07-01T00:00:00.000Z' });

    const uc = new ListInventoryMovements(movements, materialCatalog, locations);
    const result = await uc.execute({ dateFrom: '2026-06-01T00:00:00.000Z', dateTo: '2026-06-30T23:59:59.999Z' }, 1, 25);

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
  });

  it('SCEN-MOV-6: combined filters (type + locationId) returns intersection', async () => {
    const { movements, stockRepo, materialCatalog, locations } = makeRepos();

    await locations.create(createStockLocation({ id: 'loc-depot', type: 'DEPOSITO', code: 'DEPOSITO' }));
    await locations.create(createStockLocation({ id: 'loc-L1', type: 'CLIENTE', contractId: 'c-1' }));
    const mat = await materialCatalog.create({ name: 'CABLE', sortOrder: 0 });
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-depot', qty: 1000 });
    await stockRepo.upsert({ id: 'ms2', materialCatalogId: mat.id, locationId: 'loc-L1', qty: 1000 });

    // 5 CONSUME at depot
    for (let i = 0; i < 5; i++) {
      await movements.record({ type: 'CONSUME', materialCatalogId: mat.id, qty: 1, fromLocationId: 'loc-depot', source: 'TEST' });
    }
    // 2 CONSUME at L1
    for (let i = 0; i < 2; i++) {
      await movements.record({ type: 'CONSUME', materialCatalogId: mat.id, qty: 1, fromLocationId: 'loc-L1', source: 'TEST' });
    }
    // 1 RETURN to L1
    await movements.record({ type: 'RETURN', materialCatalogId: mat.id, qty: 1, toLocationId: 'loc-L1', source: 'TEST' });

    const uc = new ListInventoryMovements(movements, materialCatalog, locations);
    const result = await uc.execute({ type: 'CONSUME', locationId: 'loc-L1' }, 1, 25);

    expect(result.total).toBe(2);
    expect(result.items.every((i) => i.type === 'CONSUME')).toBe(true);
  });

  it('FIX-3: movement referencing a now-empty location still resolves label (findLabelsByIds)', async () => {
    const { movements, stockRepo, materialCatalog, locations } = makeRepos();

    // Create a location that is "now empty" — no seedContent → listWithContent() won't return it
    await locations.create(createStockLocation({ id: 'loc-empty', type: 'DEPOSITO', code: 'DEPOSITO' }));
    // Seed the label for this location via seedLabels (new test seam on findLabelsByIds)
    locations.seedLabel('loc-empty', { type: 'DEPOSITO', label: 'Depósito' });

    const mat = await materialCatalog.create({ name: 'CABLE_UTP', sortOrder: 0 });
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-empty', qty: 100 });

    await movements.record({
      type: 'CONSUME', materialCatalogId: mat.id, qty: 5,
      fromLocationId: 'loc-empty', source: 'TEST',
    });

    const uc = new ListInventoryMovements(movements, materialCatalog, locations);
    const result = await uc.execute({}, 1, 25);

    expect(result.items).toHaveLength(1);
    // The label must resolve even though listWithContent() would not include loc-empty
    expect(result.items[0].fromLocationLabel).toBe('Depósito');
  });

  it('items are enriched with materialName', async () => {
    const { movements, stockRepo, materialCatalog, locations } = makeRepos();

    await locations.create(createStockLocation({ id: 'loc-depot', type: 'DEPOSITO', code: 'DEPOSITO' }));
    const mat = await materialCatalog.create({ name: 'CABLE_UTP', label: 'Cable UTP', unit: 'm', sortOrder: 0 });
    await stockRepo.upsert({ id: 'ms1', materialCatalogId: mat.id, locationId: 'loc-depot', qty: 1000 });

    await movements.record({ type: 'CONSUME', materialCatalogId: mat.id, qty: 5, fromLocationId: 'loc-depot', source: 'TEST' });

    const uc = new ListInventoryMovements(movements, materialCatalog, locations);
    const result = await uc.execute({}, 1, 25);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].materialCatalogId).toBe(mat.id);
    expect(result.items[0].materialName).toBe('CABLE_UTP');
    expect(result.items[0].qty).toBe(5);
  });
});

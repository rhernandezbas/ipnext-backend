import { IssueStockToTechnician } from '@application/use-cases/IssueStockToTechnician';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryReturnSuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryReturnSuggestionRepository';
import { createStockLocation } from '@domain/entities/stock-location';
import { createInventoryAsset, AssetStatus } from '@domain/entities/inventory-asset';
import { createMaterialStock } from '@domain/entities/material-stock';
import { InsufficientStockError, AssetNotAtDepotError } from '@domain/errors/inventory';

interface Deps {
  locations: InMemoryStockLocationRepository;
  assets: InMemoryInventoryAssetRepository;
  stock: InMemoryMaterialStockRepository;
  movements: InMemoryInventoryMovementRepository;
  useCase: IssueStockToTechnician;
}

const DEPOT_ID = 'depot-1';
const TECH = 't-42';

function build(): Deps {
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const stock = new InMemoryMaterialStockRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, stock);
  const suggestions = new InMemoryInventorySuggestionRepository();
  const contractInv = new InMemoryContractInventoryRepository();
  const returns = new InMemoryReturnSuggestionRepository();
  const uow = new InMemoryUnitOfWork(suggestions, contractInv, locations, assets, movements, stock, returns);

  const useCase = new IssueStockToTechnician(
    new ResolveDepotLocation(locations),
    new ResolveTechnicianLocation(locations),
    assets,
    uow,
  );
  return { locations, assets, stock, movements, useCase };
}

async function seedDepot(d: Deps) {
  await d.locations.create(createStockLocation({ id: DEPOT_ID, type: 'DEPOSITO', code: 'DEPOSITO' }));
}

async function seedAsset(
  d: Deps,
  over: { id: string; serial: string; status?: AssetStatus; locationId?: string },
) {
  await d.assets.create(
    createInventoryAsset({
      id: over.id,
      serialNumber: over.serial,
      mac: null,
      deviceTypeId: 'dt-1',
      status: over.status ?? 'available',
      currentLocationId: over.locationId ?? DEPOT_ID,
      source: 'MANUAL',
      sourceTaskId: null,
    }),
  );
}

describe('IssueStockToTechnician', () => {
  it('transfers an asset from depot to the technician location (currentLocationId updated)', async () => {
    const d = build();
    await seedDepot(d);
    await seedAsset(d, { id: 'a1', serial: 'SN-1' });

    await d.useCase.execute(TECH, { items: [{ assetId: 'a1' }] });

    const techLoc = await d.locations.findByTypeAndTechnician('TECNICO', TECH);
    expect(techLoc).not.toBeNull();
    const asset = await d.assets.findById('a1');
    expect(asset!.currentLocationId).toBe(techLoc!.id);

    // ledger row is a TRANSFER, NOT an ISSUE
    expect(d.movements.movements).toHaveLength(1);
    expect(d.movements.movements[0].type).toBe('TRANSFER');
    expect(d.movements.movements[0].fromLocationId).toBe(DEPOT_ID);
    expect(d.movements.movements[0].toLocationId).toBe(techLoc!.id);
  });

  it('transfers material: decrements depot and increments technician', async () => {
    const d = build();
    await seedDepot(d);
    await d.stock.upsert(createMaterialStock({ id: 'ms1', materialCatalogId: 'cable', locationId: DEPOT_ID, qty: 10 }));

    await d.useCase.execute(TECH, { items: [{ materialCatalogId: 'cable', qty: 3 }] });

    const techLoc = await d.locations.findByTypeAndTechnician('TECNICO', TECH);
    const depotRow = await d.stock.findByMaterialAndLocation('cable', DEPOT_ID);
    const techRow = await d.stock.findByMaterialAndLocation('cable', techLoc!.id);
    expect(depotRow!.qty).toBe(7);
    expect(techRow!.qty).toBe(3);

    expect(d.movements.movements).toHaveLength(1);
    expect(d.movements.movements[0].type).toBe('TRANSFER');
  });

  it('rejects when depot has insufficient material stock — no partial apply', async () => {
    const d = build();
    await seedDepot(d);
    await d.stock.upsert(createMaterialStock({ id: 'ms1', materialCatalogId: 'cable', locationId: DEPOT_ID, qty: 2 }));

    await expect(
      d.useCase.execute(TECH, { items: [{ materialCatalogId: 'cable', qty: 5 }] }),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // nothing moved
    expect(d.movements.movements).toHaveLength(0);
    const depotRow = await d.stock.findByMaterialAndLocation('cable', DEPOT_ID);
    expect(depotRow!.qty).toBe(2);
  });

  it('multi-item batch rolls back fully when one item fails (atomic)', async () => {
    const d = build();
    await seedDepot(d);
    await seedAsset(d, { id: 'a1', serial: 'SN-1' });
    await d.stock.upsert(createMaterialStock({ id: 'ms1', materialCatalogId: 'cable', locationId: DEPOT_ID, qty: 1 }));

    await expect(
      d.useCase.execute(TECH, {
        items: [
          { assetId: 'a1' }, // would succeed
          { materialCatalogId: 'cable', qty: 99 }, // fails — insufficient
        ],
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // FULL rollback: the asset stays at depot, no movements, stock untouched
    const asset = await d.assets.findById('a1');
    expect(asset!.currentLocationId).toBe(DEPOT_ID);
    expect(d.movements.movements).toHaveLength(0);
    const depotRow = await d.stock.findByMaterialAndLocation('cable', DEPOT_ID);
    expect(depotRow!.qty).toBe(1);
  });

  it('rejects an asset that is not available at the depot (no transfer)', async () => {
    const d = build();
    await seedDepot(d);
    // asset is installed at a client location, not available at depot
    await seedAsset(d, { id: 'a1', serial: 'SN-1', status: 'installed', locationId: 'client-loc' });

    await expect(
      d.useCase.execute(TECH, { items: [{ assetId: 'a1' }] }),
    ).rejects.toBeInstanceOf(AssetNotAtDepotError);

    const asset = await d.assets.findById('a1');
    expect(asset!.currentLocationId).toBe('client-loc');
    expect(d.movements.movements).toHaveLength(0);
  });

  it('rejects an asset that is available but NOT at the depot location', async () => {
    const d = build();
    await seedDepot(d);
    await seedAsset(d, { id: 'a1', serial: 'SN-1', status: 'available', locationId: 'somewhere-else' });

    await expect(
      d.useCase.execute(TECH, { items: [{ assetId: 'a1' }] }),
    ).rejects.toBeInstanceOf(AssetNotAtDepotError);
    expect(d.movements.movements).toHaveLength(0);
  });
});

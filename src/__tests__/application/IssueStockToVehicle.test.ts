/**
 * SCEN-IS-1..5 — IssueStockToVehicle use-case tests (EPIC #38, Wave 5b).
 * In-memory repos only; no Prisma.
 */
import { IssueStockToVehicle } from '@application/use-cases/IssueStockToVehicle';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { ResolveVehicleLocation } from '@application/use-cases/ResolveVehicleLocation';
import { InMemoryVehicleRepository } from '@infrastructure/adapters/in-memory/InMemoryVehicleRepository';
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
import { VehicleNotFoundError, VehicleInactiveError, AssetNotAtDepotError, InsufficientStockError } from '@domain/errors/inventory';

const DEPOT_ID = 'depot-1';
const VEHICLE_ID = 'V1';

interface Deps {
  vehicles: InMemoryVehicleRepository;
  locations: InMemoryStockLocationRepository;
  assets: InMemoryInventoryAssetRepository;
  stock: InMemoryMaterialStockRepository;
  movements: InMemoryInventoryMovementRepository;
  useCase: IssueStockToVehicle;
}

function build(): Deps {
  const vehicles = new InMemoryVehicleRepository();
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const stock = new InMemoryMaterialStockRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, stock);
  const suggestions = new InMemoryInventorySuggestionRepository();
  const contractInv = new InMemoryContractInventoryRepository();
  const returns = new InMemoryReturnSuggestionRepository();
  const uow = new InMemoryUnitOfWork(suggestions, contractInv, locations, assets, movements, stock, returns);

  const useCase = new IssueStockToVehicle(
    vehicles,
    new ResolveDepotLocation(locations),
    new ResolveVehicleLocation(locations),
    assets,
    uow,
  );
  return { vehicles, locations, assets, stock, movements, useCase };
}

async function seedDepot(d: Deps) {
  await d.locations.create(createStockLocation({ id: DEPOT_ID, type: 'DEPOSITO', code: 'DEPOSITO' }));
}

async function seedActiveVehicle(d: Deps, id = VEHICLE_ID) {
  await d.vehicles.create({ id, plate: `PLATE-${id}`, name: null, assignedTechnicianId: null, status: 'active', createdAt: new Date() });
}

async function seedInactiveVehicle(d: Deps, id = VEHICLE_ID) {
  await d.vehicles.create({ id, plate: `PLATE-${id}`, name: null, assignedTechnicianId: null, status: 'inactive', createdAt: new Date() });
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

describe('IssueStockToVehicle', () => {
  // SCEN-IS-1: happy path — asset + material transferred atomically
  it('SCEN-IS-1: transfers asset + material from depot to vehicle CAMIONETA location', async () => {
    const d = build();
    await seedDepot(d);
    await seedActiveVehicle(d);
    await seedAsset(d, { id: 'a1', serial: 'SN-1' });
    await d.stock.upsert(createMaterialStock({ id: 'ms1', materialCatalogId: 'cable', locationId: DEPOT_ID, qty: 10 }));

    await d.useCase.execute(VEHICLE_ID, { items: [{ assetId: 'a1' }, { materialCatalogId: 'cable', qty: 2 }] });

    const vehLoc = await d.locations.findByTypeAndVehicle('CAMIONETA', VEHICLE_ID);
    expect(vehLoc).not.toBeNull();

    const asset = await d.assets.findById('a1');
    expect(asset!.currentLocationId).toBe(vehLoc!.id);

    const depotMat = await d.stock.findByMaterialAndLocation('cable', DEPOT_ID);
    expect(depotMat!.qty).toBe(8);

    const vehMat = await d.stock.findByMaterialAndLocation('cable', vehLoc!.id);
    expect(vehMat!.qty).toBe(2);

    // All movements are TRANSFER (not ISSUE)
    expect(d.movements.movements).toHaveLength(2);
    expect(d.movements.movements.every((m) => m.type === 'TRANSFER')).toBe(true);
  });

  // SCEN-IS-2: vehicle not found → VehicleNotFoundError (404)
  it('SCEN-IS-2: vehicle not found → VehicleNotFoundError', async () => {
    const d = build();
    await expect(d.useCase.execute('X1', { items: [{ assetId: 'a1' }] })).rejects.toThrow(VehicleNotFoundError);
  });

  // SCEN-IS-3: inactive vehicle → VehicleInactiveError (422)
  it('SCEN-IS-3: inactive vehicle → VehicleInactiveError', async () => {
    const d = build();
    await seedDepot(d);
    await seedInactiveVehicle(d);
    await expect(d.useCase.execute(VEHICLE_ID, { items: [{ assetId: 'a1' }] })).rejects.toThrow(VehicleInactiveError);
    // no movements
    expect(d.movements.movements).toHaveLength(0);
  });

  // SCEN-IS-4: asset not at depot → 409 AssetNotAtDepotError
  it('SCEN-IS-4: asset at client location → AssetNotAtDepotError', async () => {
    const d = build();
    await seedDepot(d);
    await seedActiveVehicle(d);
    await seedAsset(d, { id: 'a1', serial: 'SN-1', status: 'installed', locationId: 'client-loc' });
    await expect(d.useCase.execute(VEHICLE_ID, { items: [{ assetId: 'a1' }] })).rejects.toThrow(AssetNotAtDepotError);
    expect(d.movements.movements).toHaveLength(0);
  });

  // SCEN-IS-5: insufficient depot material → 409 InsufficientStockError
  it('SCEN-IS-5: insufficient depot material → InsufficientStockError', async () => {
    const d = build();
    await seedDepot(d);
    await seedActiveVehicle(d);
    await d.stock.upsert(createMaterialStock({ id: 'ms1', materialCatalogId: 'cable', locationId: DEPOT_ID, qty: 1 }));
    await expect(d.useCase.execute(VEHICLE_ID, { items: [{ materialCatalogId: 'cable', qty: 5 }] })).rejects.toThrow(InsufficientStockError);
    expect(d.movements.movements).toHaveLength(0);
    const depotRow = await d.stock.findByMaterialAndLocation('cable', DEPOT_ID);
    expect(depotRow!.qty).toBe(1);
  });
});

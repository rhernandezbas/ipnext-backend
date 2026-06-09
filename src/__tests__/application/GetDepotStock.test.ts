import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { createStockLocation } from '@domain/entities/stock-location';
import { createInventoryAsset, AssetStatus } from '@domain/entities/inventory-asset';
import { createMaterialStock } from '@domain/entities/material-stock';

interface Deps {
  locations: InMemoryStockLocationRepository;
  assets: InMemoryInventoryAssetRepository;
  stock: InMemoryMaterialStockRepository;
  deviceTypes: InMemoryDeviceTypeCatalogRepository;
  materials: InMemoryMaterialCatalogRepository;
  useCase: GetDepotStock;
}

function build(): Deps {
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const stock = new InMemoryMaterialStockRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  const materials = new InMemoryMaterialCatalogRepository();
  const useCase = new GetDepotStock(locations, assets, stock, deviceTypes, materials);
  return { locations, assets, stock, deviceTypes, materials, useCase };
}

async function seedAsset(
  d: Deps,
  over: { id: string; serialNumber: string; deviceTypeId: string; status: AssetStatus; locationId: string; mac?: string | null; sourceTaskId?: string | null },
) {
  await d.assets.create(
    createInventoryAsset({
      id: over.id,
      serialNumber: over.serialNumber,
      mac: over.mac ?? null,
      deviceTypeId: over.deviceTypeId,
      status: over.status,
      currentLocationId: over.locationId,
      source: 'MANUAL',
      sourceTaskId: over.sourceTaskId ?? null,
    }),
  );
}

describe('GetDepotStock', () => {
  it('returns empty shape with depotLocationId=null when DEPOSITO does not exist', async () => {
    const d = build();
    const result = await d.useCase.execute();
    expect(result).toEqual({ assets: [], materials: [], depotLocationId: null });
  });

  it('returns only available assets, enriched with device type catalog', async () => {
    const d = build();
    await d.locations.create(createStockLocation({ id: 'depot-1', type: 'DEPOSITO', code: 'DEPOSITO' }));
    const onu = await d.deviceTypes.create({ name: 'ONU', label: 'Optical Unit', active: true, sortOrder: 0 });

    await seedAsset(d, { id: 'a1', serialNumber: 'SN-A1', deviceTypeId: onu.id, status: 'available', locationId: 'depot-1', mac: 'MAC1', sourceTaskId: 't9' });
    // installed asset at the depot must be filtered out by the use case
    await seedAsset(d, { id: 'a2', serialNumber: 'SN-A2', deviceTypeId: onu.id, status: 'installed', locationId: 'depot-1' });
    // available asset at a DIFFERENT location must not appear
    await seedAsset(d, { id: 'a3', serialNumber: 'SN-A3', deviceTypeId: onu.id, status: 'available', locationId: 'other-loc' });

    const result = await d.useCase.execute();

    expect(result.depotLocationId).toBe('depot-1');
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toEqual({
      id: 'a1',
      serialNumber: 'SN-A1',
      mac: 'MAC1',
      deviceTypeId: onu.id,
      deviceTypeName: 'ONU',
      deviceTypeLabel: 'Optical Unit',
      status: 'available',
      sourceTaskId: 't9',
    });
  });

  it('returns all material stock rows enriched with material catalog', async () => {
    const d = build();
    await d.locations.create(createStockLocation({ id: 'depot-1', type: 'DEPOSITO', code: 'DEPOSITO' }));
    const cable = await d.materials.create({ name: 'CABLE_UTP', label: 'Cable UTP', unit: 'm', active: true, sortOrder: 0 });

    await d.stock.upsert(createMaterialStock({ id: 'ms1', materialCatalogId: cable.id, locationId: 'depot-1', qty: 42 }));
    // stock at a different location must be excluded
    await d.stock.upsert(createMaterialStock({ id: 'ms2', materialCatalogId: cable.id, locationId: 'other-loc', qty: 5 }));

    const result = await d.useCase.execute();

    expect(result.materials).toHaveLength(1);
    expect(result.materials[0]).toEqual({
      id: 'ms1',
      materialCatalogId: cable.id,
      name: 'CABLE_UTP',
      label: 'Cable UTP',
      unit: 'm',
      qty: 42,
    });
  });

  it('tolerates missing catalog rows (null name/label/unit) without throwing', async () => {
    const d = build();
    await d.locations.create(createStockLocation({ id: 'depot-1', type: 'DEPOSITO', code: 'DEPOSITO' }));
    await seedAsset(d, { id: 'a1', serialNumber: 'SN-A1', deviceTypeId: 'missing-dt', status: 'available', locationId: 'depot-1' });
    await d.stock.upsert(createMaterialStock({ id: 'ms1', materialCatalogId: 'missing-mat', locationId: 'depot-1', qty: 1 }));

    const result = await d.useCase.execute();

    expect(result.assets[0].deviceTypeName).toBeNull();
    expect(result.assets[0].deviceTypeLabel).toBeNull();
    expect(result.materials[0].name).toBeNull();
    expect(result.materials[0].unit).toBeNull();
  });
});

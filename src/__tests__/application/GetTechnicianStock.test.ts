import { GetTechnicianStock } from '@application/use-cases/GetTechnicianStock';
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
  useCase: GetTechnicianStock;
}

function build(): Deps {
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const stock = new InMemoryMaterialStockRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  const materials = new InMemoryMaterialCatalogRepository();
  const useCase = new GetTechnicianStock(locations, assets, stock, deviceTypes, materials);
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

describe('GetTechnicianStock', () => {
  it('returns empty shape with locationId=null when the technician has no location (no create on GET)', async () => {
    const d = build();
    const result = await d.useCase.execute('t-42');
    expect(result).toEqual({ technicianId: 't-42', assets: [], materials: [], locationId: null });
    // GET must NOT create the location
    expect(d.locations.store.size).toBe(0);
  });

  it('returns only available assets at the technician location, enriched with device type catalog', async () => {
    const d = build();
    await d.locations.create(createStockLocation({ id: 'tec-1', type: 'TECNICO', technicianId: 't-42' }));
    const onu = await d.deviceTypes.create({ name: 'ONU', label: 'Optical Unit', active: true, sortOrder: 0 });

    await seedAsset(d, { id: 'a1', serialNumber: 'SN-A1', deviceTypeId: onu.id, status: 'available', locationId: 'tec-1', mac: 'MAC1', sourceTaskId: 't9' });
    // installed asset at the technician must be filtered out
    await seedAsset(d, { id: 'a2', serialNumber: 'SN-A2', deviceTypeId: onu.id, status: 'installed', locationId: 'tec-1' });
    // available asset at a DIFFERENT location must not appear
    await seedAsset(d, { id: 'a3', serialNumber: 'SN-A3', deviceTypeId: onu.id, status: 'available', locationId: 'other-loc' });

    const result = await d.useCase.execute('t-42');

    expect(result.technicianId).toBe('t-42');
    expect(result.locationId).toBe('tec-1');
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

  it('returns material stock rows at the technician location enriched with material catalog', async () => {
    const d = build();
    await d.locations.create(createStockLocation({ id: 'tec-1', type: 'TECNICO', technicianId: 't-42' }));
    const cable = await d.materials.create({ name: 'CABLE_UTP', label: 'Cable UTP', unit: 'm', active: true, sortOrder: 0 });

    await d.stock.upsert(createMaterialStock({ id: 'ms1', materialCatalogId: cable.id, locationId: 'tec-1', qty: 12 }));
    // stock at a different location must be excluded
    await d.stock.upsert(createMaterialStock({ id: 'ms2', materialCatalogId: cable.id, locationId: 'other-loc', qty: 5 }));

    const result = await d.useCase.execute('t-42');

    expect(result.materials).toHaveLength(1);
    expect(result.materials[0]).toEqual({
      id: 'ms1',
      materialCatalogId: cable.id,
      name: 'CABLE_UTP',
      label: 'Cable UTP',
      unit: 'm',
      qty: 12,
    });
  });

  it('tolerates missing catalog rows (null name/label/unit) without throwing', async () => {
    const d = build();
    await d.locations.create(createStockLocation({ id: 'tec-1', type: 'TECNICO', technicianId: 't-42' }));
    await seedAsset(d, { id: 'a1', serialNumber: 'SN-A1', deviceTypeId: 'missing-dt', status: 'available', locationId: 'tec-1' });
    await d.stock.upsert(createMaterialStock({ id: 'ms1', materialCatalogId: 'missing-mat', locationId: 'tec-1', qty: 1 }));

    const result = await d.useCase.execute('t-42');

    expect(result.assets[0].deviceTypeName).toBeNull();
    expect(result.assets[0].deviceTypeLabel).toBeNull();
    expect(result.materials[0].name).toBeNull();
    expect(result.materials[0].unit).toBeNull();
  });
});

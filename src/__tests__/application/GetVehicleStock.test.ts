/**
 * SCEN-GS-1..3 — GetVehicleStock use-case tests (EPIC #38, Wave 5b).
 * In-memory repos only; no Prisma.
 */
import { GetVehicleStock } from '@application/use-cases/GetVehicleStock';
import { InMemoryVehicleRepository } from '@infrastructure/adapters/in-memory/InMemoryVehicleRepository';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { createStockLocation } from '@domain/entities/stock-location';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import { createMaterialStock } from '@domain/entities/material-stock';
import { VehicleNotFoundError } from '@domain/errors/inventory';

function build() {
  const vehicles = new InMemoryVehicleRepository();
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const stock = new InMemoryMaterialStockRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  const materials = new InMemoryMaterialCatalogRepository();
  const useCase = new GetVehicleStock(vehicles, locations, assets, stock, deviceTypes, materials);
  return { vehicles, locations, assets, stock, deviceTypes, materials, useCase };
}

async function seedVehicle(vehicles: InMemoryVehicleRepository, id: string) {
  await vehicles.create({ id, plate: `PLATE-${id}`, name: null, assignedTechnicianId: null, status: 'active', createdAt: new Date() });
}

describe('GetVehicleStock', () => {
  // SCEN-GS-3: unknown vehicle → VehicleNotFoundError (404)
  it('SCEN-GS-3: unknown vehicle throws VehicleNotFoundError', async () => {
    const { useCase } = build();
    await expect(useCase.execute('X1')).rejects.toThrow(VehicleNotFoundError);
  });

  // SCEN-GS-2: vehicle exists but no CAMIONETA location → empty DTO (no 404)
  it('SCEN-GS-2: no CAMIONETA location → empty DTO', async () => {
    const { useCase, vehicles } = build();
    await seedVehicle(vehicles, 'V1');
    const dto = await useCase.execute('V1');
    expect(dto.vehicleId).toBe('V1');
    expect(dto.assets).toHaveLength(0);
    expect(dto.materials).toHaveLength(0);
  });

  // SCEN-GS-1: vehicle with CAMIONETA location + items → enriched DTO
  it('SCEN-GS-1: stock after issuance returns enriched items', async () => {
    const { useCase, vehicles, locations, assets, stock, deviceTypes, materials } = build();
    await seedVehicle(vehicles, 'V1');
    await locations.create(createStockLocation({ id: 'cam-1', type: 'CAMIONETA', vehicleId: 'V1' }));
    const onu = await deviceTypes.create({ name: 'ONU', label: 'Optical Unit', active: true, sortOrder: 0 });
    const cable = await materials.create({ name: 'CABLE_UTP', label: 'Cable UTP', unit: 'm', active: true, sortOrder: 0 });
    await assets.create(
      createInventoryAsset({ id: 'a1', serialNumber: 'SN-A1', mac: 'MAC1', deviceTypeId: onu.id, status: 'available', currentLocationId: 'cam-1', source: 'MANUAL', sourceTaskId: null }),
    );
    await stock.upsert(createMaterialStock({ id: 'ms1', materialCatalogId: cable.id, locationId: 'cam-1', qty: 5 }));

    const dto = await useCase.execute('V1');
    expect(dto.vehicleId).toBe('V1');
    expect(dto.assets).toHaveLength(1);
    expect(dto.assets[0].serialNumber).toBe('SN-A1');
    expect(dto.assets[0].deviceTypeName).toBe('ONU');
    expect(dto.materials).toHaveLength(1);
    expect(dto.materials[0].name).toBe('CABLE_UTP');
    expect(dto.materials[0].qty).toBe(5);
  });
});

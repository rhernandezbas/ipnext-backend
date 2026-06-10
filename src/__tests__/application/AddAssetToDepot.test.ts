import { AddAssetToDepot } from '@application/use-cases/AddAssetToDepot';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import {
  AssetAlreadyExistsError,
  AssetIdentifierRequiredError,
  DeviceTypeNotFoundError,
} from '@domain/errors/inventory';

async function setup() {
  const assets = new InMemoryInventoryAssetRepository();
  const materials = new InMemoryMaterialStockRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, materials);
  const locations = new InMemoryStockLocationRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  const materialCatalog = new InMemoryMaterialCatalogRepository();
  const suggestions = new InMemoryInventorySuggestionRepository();
  const contractInv = new InMemoryContractInventoryRepository();
  const uow = new InMemoryUnitOfWork(suggestions, contractInv, locations, assets, movements, materials);

  const onu = await deviceTypes.create({ name: 'ONU', label: 'Optical Unit', active: true, sortOrder: 0 });
  const resolveDepot = new ResolveDepotLocation(locations);

  const useCase = new AddAssetToDepot(assets, movements, deviceTypes, resolveDepot, uow);
  const getDepot = new GetDepotStock(locations, assets, materials, deviceTypes, materialCatalog);

  return { assets, movements, locations, deviceTypes, uow, useCase, getDepot, onu, resolveDepot };
}

describe('AddAssetToDepot', () => {
  it('happy path — asset available@depot + ADJUST in ledger + visible via GetDepotStock', async () => {
    const { useCase, movements, locations, getDepot, onu } = await setup();

    const result = await useCase.execute({
      deviceTypeId: onu.id,
      serialNumber: 'SN-MANUAL-001',
      mac: null,
      note: 'test entry',
    });

    // Output shape
    expect(result.id).toBeDefined();
    expect(result.deviceTypeId).toBe(onu.id);
    expect(result.deviceTypeName).toBe('ONU');
    expect(result.serialNumber).toBe('SN-MANUAL-001');
    expect(result.mac).toBeNull();
    expect(result.status).toBe('available');

    // ADJUST ledger movement recorded
    const depot = await locations.findByCode('DEPOSITO');
    expect(depot).not.toBeNull();
    expect(movements.movements).toHaveLength(1);
    expect(movements.movements[0].type).toBe('ADJUST');
    expect(movements.movements[0].assetId).toBe(result.id);
    expect(movements.movements[0].toLocationId).toBe(depot!.id);
    expect(movements.movements[0].source).toBe('MANUAL');

    // Visible in depot stock
    const stock = await getDepot.execute();
    expect(stock.assets).toHaveLength(1);
    expect(stock.assets[0].serialNumber).toBe('SN-MANUAL-001');
    expect(stock.assets[0].status).toBe('available');
  });

  it('happy path with MAC only (no serial) — synthetic serial generated', async () => {
    const { useCase, movements, onu } = await setup();

    const result = await useCase.execute({
      deviceTypeId: onu.id,
      serialNumber: null,
      mac: 'AA:BB:CC:DD:EE:FF',
    });

    expect(result.mac).toBe('AA:BB:CC:DD:EE:FF');
    expect(result.serialNumber).toBeNull();
    // synthetic serial stored internally
    expect(movements.movements).toHaveLength(1);
    expect(movements.movements[0].type).toBe('ADJUST');
  });

  it('duplicate serialNumber → AssetAlreadyExistsError (409)', async () => {
    const { useCase, onu } = await setup();

    await useCase.execute({ deviceTypeId: onu.id, serialNumber: 'SN-DUP', mac: null });

    await expect(
      useCase.execute({ deviceTypeId: onu.id, serialNumber: 'SN-DUP', mac: null }),
    ).rejects.toBeInstanceOf(AssetAlreadyExistsError);
  });

  it('duplicate mac → AssetAlreadyExistsError (409)', async () => {
    const { useCase, onu } = await setup();

    await useCase.execute({ deviceTypeId: onu.id, serialNumber: 'SN-MAC-001', mac: 'AA:BB:CC:DD:EE:FF' });

    await expect(
      useCase.execute({ deviceTypeId: onu.id, serialNumber: 'SN-MAC-002', mac: 'AA:BB:CC:DD:EE:FF' }),
    ).rejects.toBeInstanceOf(AssetAlreadyExistsError);
  });

  it('neither serialNumber nor mac provided → AssetIdentifierRequiredError (400)', async () => {
    const { useCase, onu } = await setup();

    await expect(
      useCase.execute({ deviceTypeId: onu.id, serialNumber: null, mac: null }),
    ).rejects.toBeInstanceOf(AssetIdentifierRequiredError);
  });

  it('empty strings for both identifiers → AssetIdentifierRequiredError (400)', async () => {
    const { useCase, onu } = await setup();

    await expect(
      useCase.execute({ deviceTypeId: onu.id, serialNumber: '   ', mac: '' }),
    ).rejects.toBeInstanceOf(AssetIdentifierRequiredError);
  });

  it('unknown deviceTypeId → DeviceTypeNotFoundError (404)', async () => {
    const { useCase } = await setup();

    await expect(
      useCase.execute({ deviceTypeId: 'unknown-dt', serialNumber: 'SN-NOTFOUND', mac: null }),
    ).rejects.toBeInstanceOf(DeviceTypeNotFoundError);
  });

  // ── FIX 2a: normalized serial guard ──────────────────────────────────────

  // ── FIX 3: mac uniqueness enforced in-memory (mirrors DB partial unique) ─

  it('FIX3 — in-memory: second create with same mac → throws P2002-shaped error', async () => {
    // The in-memory adapter must mirror the DB partial unique on mac (non-null).
    // The test verifies that creating two assets with the same mac throws a
    // P2002-shaped error (code: 'P2002'), which is the same signal the route maps to 409.
    const { assets, onu, resolveDepot } = await setup();

    // Resolve (create) the depot location first.
    const depot = await resolveDepot.execute('DEPOSITO');

    const { createInventoryAsset } = await import('@domain/entities/inventory-asset');
    const { randomUUID } = await import('crypto');

    const asset1 = createInventoryAsset({
      id: randomUUID(),
      serialNumber: 'SN-MAC-A',
      mac: 'AA:BB:CC:DD:EE:FF',
      deviceTypeId: onu.id,
      status: 'available',
      currentLocationId: depot.id,
      source: 'MANUAL',
      sourceTaskId: null,
    });
    const asset2 = createInventoryAsset({
      id: randomUUID(),
      serialNumber: 'SN-MAC-B', // different serial
      mac: 'AA:BB:CC:DD:EE:FF', // same mac
      deviceTypeId: onu.id,
      status: 'available',
      currentLocationId: depot.id,
      source: 'MANUAL',
      sourceTaskId: null,
    });

    await assets.create(asset1);
    const err = await assets.create(asset2).catch((e: unknown) => e);
    expect(err).toBeTruthy();
    expect((err as { code?: string }).code).toBe('P2002');
  });

  // ── FIX 2a: normalized serial guard ──────────────────────────────────────

  it('FIX2a — duplicate serial with dashes/case → AssetAlreadyExistsError (normalized match)', async () => {
    // 'SN-AAA-001' normalized = 'SNAAA001'; 'sn-aaa-001' normalizes to the same.
    const { useCase, onu } = await setup();

    await useCase.execute({ deviceTypeId: onu.id, serialNumber: 'SN-AAA-001', mac: null });

    // Different raw value, same normalized form — must be rejected.
    await expect(
      useCase.execute({ deviceTypeId: onu.id, serialNumber: 'SNAAA001', mac: null }),
    ).rejects.toBeInstanceOf(AssetAlreadyExistsError);
  });

  it('atomicity: if movement fails → no asset persisted', async () => {
    const { assets, movements, onu, resolveDepot, deviceTypes, uow } = await setup();
    // Poison the movements.record to throw on ADJUST
    const original = movements.record.bind(movements);
    movements.record = async (input) => {
      if (input.type === 'ADJUST') throw new Error('simulated movement failure');
      return original(input);
    };

    const useCase = new AddAssetToDepot(assets, movements, deviceTypes, resolveDepot, uow);

    await expect(
      useCase.execute({ deviceTypeId: onu.id, serialNumber: 'SN-ATOMIC', mac: null }),
    ).rejects.toThrow('simulated movement failure');

    // Asset must NOT have been persisted (UoW rolled back)
    const found = await assets.findBySerialNumber('SN-ATOMIC');
    expect(found).toBeNull();
  });
});

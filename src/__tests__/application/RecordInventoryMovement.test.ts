import { RecordInventoryMovement } from '@application/use-cases/RecordInventoryMovement';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { createInventoryAsset } from '@domain/entities/inventory-asset';

function setup() {
  const assets = new InMemoryInventoryAssetRepository();
  const materials = new InMemoryMaterialStockRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, materials);
  const uc = new RecordInventoryMovement(movements);
  return { assets, materials, movements, uc };
}

const L_DEPOT = 'L_depot';
const L_CLIENT = 'L_client';
const L2 = 'L2';

describe('RecordInventoryMovement — serialized (asset) movements', () => {
  it('INSTALL moves asset depot→client and sets status=installed', async () => {
    const { assets, movements, uc } = setup();
    await assets.create(
      createInventoryAsset({ id: 'A1', serialNumber: 'SN1', deviceTypeId: 'd1', currentLocationId: L_DEPOT, source: 'MANUAL', status: 'available' }),
    );

    const mv = await uc.execute({ type: 'INSTALL', assetId: 'A1', fromLocationId: L_DEPOT, toLocationId: L_CLIENT, taskId: 'T1', source: 'ICLASS' });

    expect(mv.type).toBe('INSTALL');
    const a = await assets.findById('A1');
    expect(a!.currentLocationId).toBe(L_CLIENT);
    expect(a!.status).toBe('installed');
    expect(movements.movements).toHaveLength(1);
  });

  it('RETURN moves asset client→depot and sets status=available', async () => {
    const { assets, uc } = setup();
    await assets.create(
      createInventoryAsset({ id: 'A1', serialNumber: 'SN1', deviceTypeId: 'd1', currentLocationId: L_CLIENT, source: 'MANUAL', status: 'installed' }),
    );

    await uc.execute({ type: 'RETURN', assetId: 'A1', fromLocationId: L_CLIENT, toLocationId: L_DEPOT, source: 'MANUAL' });

    const a = await assets.findById('A1');
    expect(a!.currentLocationId).toBe(L_DEPOT);
    expect(a!.status).toBe('available');
  });

  it('balance-matches-net-of-movements: INSTALL then RETURN leaves asset at depot/available + 2 ledger rows', async () => {
    const { assets, movements, uc } = setup();
    await assets.create(
      createInventoryAsset({ id: 'A1', serialNumber: 'SN1', deviceTypeId: 'd1', currentLocationId: L_DEPOT, source: 'MANUAL', status: 'available' }),
    );

    await uc.execute({ type: 'INSTALL', assetId: 'A1', toLocationId: L_CLIENT, taskId: 'T1', source: 'X' });
    await uc.execute({ type: 'RETURN', assetId: 'A1', toLocationId: L_DEPOT, source: 'X' });

    const a = await assets.findById('A1');
    expect(a!.currentLocationId).toBe(L_DEPOT);
    expect(a!.status).toBe('available');
    expect(await movements.listByAsset('A1')).toHaveLength(2);
  });

  it('failed-install-leaves-asset-unchanged: bad shape (asset+material) rejects before mutation', async () => {
    const { assets, movements, uc } = setup();
    await assets.create(
      createInventoryAsset({ id: 'A1', serialNumber: 'SN1', deviceTypeId: 'd1', currentLocationId: L_DEPOT, source: 'MANUAL', status: 'available' }),
    );

    await expect(
      uc.execute({ type: 'INSTALL', assetId: 'A1', materialCatalogId: 'M1', qty: 1, toLocationId: L_CLIENT, source: 'X' }),
    ).rejects.toMatchObject({ code: 'INCONSISTENT_MOVEMENT' });

    const a = await assets.findById('A1');
    expect(a!.currentLocationId).toBe(L_DEPOT);
    expect(a!.status).toBe('available');
    expect(movements.movements).toHaveLength(0);
  });
});

describe('RecordInventoryMovement — consumable (material) movements', () => {
  it('CONSUME decrements material stock', async () => {
    const { materials, movements, uc } = setup();
    await materials.upsert({ id: 's1', materialCatalogId: 'M1', locationId: L_DEPOT, qty: 20 });

    await uc.execute({ type: 'CONSUME', materialCatalogId: 'M1', qty: 5, fromLocationId: L_DEPOT, taskId: 'T1', technicianId: 'U1', source: 'ICLASS' });

    const s = await materials.findByMaterialAndLocation('M1', L_DEPOT);
    expect(s!.qty).toBe(15);
    expect(movements.movements).toHaveLength(1);
  });

  it('CONSUME rejected when insufficient stock; qty unchanged; no ledger row', async () => {
    const { materials, movements, uc } = setup();
    await materials.upsert({ id: 's1', materialCatalogId: 'M1', locationId: L_DEPOT, qty: 3 });

    await expect(
      uc.execute({ type: 'CONSUME', materialCatalogId: 'M1', qty: 10, fromLocationId: L_DEPOT, source: 'X' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    const s = await materials.findByMaterialAndLocation('M1', L_DEPOT);
    expect(s!.qty).toBe(3);
    expect(movements.movements).toHaveLength(0);
  });

  it('failed-consume-leaves-balance-unchanged: exact-zero edge still fine but negative rejects', async () => {
    const { materials, uc } = setup();
    await materials.upsert({ id: 's1', materialCatalogId: 'M1', locationId: L_DEPOT, qty: 5 });

    // exact zero is allowed
    await uc.execute({ type: 'CONSUME', materialCatalogId: 'M1', qty: 5, fromLocationId: L_DEPOT, source: 'X' });
    const s = await materials.findByMaterialAndLocation('M1', L_DEPOT);
    expect(s!.qty).toBe(0);
  });

  it('TRANSFER moves a material batch between locations', async () => {
    const { materials, movements, uc } = setup();
    await materials.upsert({ id: 's1', materialCatalogId: 'M1', locationId: 'L1', qty: 50 });
    await materials.upsert({ id: 's2', materialCatalogId: 'M1', locationId: L2, qty: 0 });

    await uc.execute({ type: 'TRANSFER', materialCatalogId: 'M1', qty: 10, fromLocationId: 'L1', toLocationId: L2, source: 'X' });

    expect((await materials.findByMaterialAndLocation('M1', 'L1'))!.qty).toBe(40);
    expect((await materials.findByMaterialAndLocation('M1', L2))!.qty).toBe(10);
    expect(movements.movements).toHaveLength(1);
  });

  it('ADJUST(material) adds delta to balance (DELTA-additive, FIX W1 cardinal)', async () => {
    // FIX W1: ADJUST(material) is now additive — the ledger row qty IS the delta,
    // both adapters apply it via increment. Old SET semantics are gone.
    const { materials, movements, uc } = setup();
    await materials.upsert({ id: 's1', materialCatalogId: 'M1', locationId: 'L1', qty: 10 });

    const mv = await uc.execute({ type: 'ADJUST', materialCatalogId: 'M1', qty: 15, toLocationId: 'L1', note: 'physical count correction', source: 'X' });

    // 10 (seed) + 15 (delta) = 25
    expect((await materials.findByMaterialAndLocation('M1', 'L1'))!.qty).toBe(25);
    expect(mv.note).toBe('physical count correction');
    expect(movements.movements).toHaveLength(1);
    // The ledger row records the delta, not the running total.
    expect(mv.qty).toBe(15);
  });

  it('ISSUE decrements material stock at fromLocationId (Fix #5)', async () => {
    const { materials, movements, uc } = setup();
    await materials.upsert({ id: 's1', materialCatalogId: 'M1', locationId: L_DEPOT, qty: 20 });

    await uc.execute({ type: 'ISSUE', materialCatalogId: 'M1', qty: 8, fromLocationId: L_DEPOT, technicianId: 'U1', source: 'X' });

    expect((await materials.findByMaterialAndLocation('M1', L_DEPOT))!.qty).toBe(12);
    expect(movements.movements).toHaveLength(1);
    expect(movements.movements[0].type).toBe('ISSUE');
  });

  it('ISSUE rejected when insufficient stock; balance unchanged; no ledger row (Fix #5)', async () => {
    const { materials, movements, uc } = setup();
    await materials.upsert({ id: 's1', materialCatalogId: 'M1', locationId: L_DEPOT, qty: 3 });

    await expect(
      uc.execute({ type: 'ISSUE', materialCatalogId: 'M1', qty: 10, fromLocationId: L_DEPOT, source: 'X' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    expect((await materials.findByMaterialAndLocation('M1', L_DEPOT))!.qty).toBe(3);
    expect(movements.movements).toHaveLength(0);
  });

  it('TRANSFER of an asset updates the asset currentLocationId (Fix M1 — assets relocate via TRANSFER, not ISSUE)', async () => {
    const { assets, movements, uc } = setup();
    await assets.create(
      createInventoryAsset({ id: 'A1', serialNumber: 'SN1', deviceTypeId: 'd1', currentLocationId: L_DEPOT, source: 'MANUAL', status: 'available' }),
    );

    await uc.execute({ type: 'TRANSFER', assetId: 'A1', fromLocationId: L_DEPOT, toLocationId: L2, technicianId: 'U1', source: 'X' });

    const a = await assets.findById('A1');
    expect(a!.currentLocationId).toBe(L2);
    expect(movements.movements).toHaveLength(1);
  });

  it('ISSUE of an asset is rejected (Fix M1 — ISSUE is a material-only verb)', async () => {
    const { assets, movements, uc } = setup();
    await assets.create(
      createInventoryAsset({ id: 'A1', serialNumber: 'SN1', deviceTypeId: 'd1', currentLocationId: L_DEPOT, source: 'MANUAL', status: 'available' }),
    );

    await expect(
      uc.execute({ type: 'ISSUE', assetId: 'A1', fromLocationId: L_DEPOT, toLocationId: L2, source: 'X' }),
    ).rejects.toMatchObject({ code: 'INCONSISTENT_MOVEMENT' });

    expect(movements.movements).toHaveLength(0);
  });

  it('material-balance-matches-net-of-movements: 50 - 10 - 5 = 35', async () => {
    const { materials, uc } = setup();
    await materials.upsert({ id: 's1', materialCatalogId: 'M1', locationId: L_DEPOT, qty: 50 });

    await uc.execute({ type: 'CONSUME', materialCatalogId: 'M1', qty: 10, fromLocationId: L_DEPOT, source: 'X' });
    await uc.execute({ type: 'CONSUME', materialCatalogId: 'M1', qty: 5, fromLocationId: L_DEPOT, source: 'X' });

    expect((await materials.findByMaterialAndLocation('M1', L_DEPOT))!.qty).toBe(35);
  });
});

describe('RecordInventoryMovement — guards', () => {
  it('XOR-guard: neither asset nor material rejected', async () => {
    const { uc } = setup();
    await expect(
      uc.execute({ type: 'ADJUST', source: 'X' }),
    ).rejects.toMatchObject({ code: 'INCONSISTENT_MOVEMENT' });
  });

  it('qty-not-positive guard: material movement with qty=0 rejected', async () => {
    const { uc } = setup();
    await expect(
      uc.execute({ type: 'CONSUME', materialCatalogId: 'M1', qty: 0, fromLocationId: L_DEPOT, source: 'X' }),
    ).rejects.toMatchObject({ code: 'INCONSISTENT_MOVEMENT' });
  });

  it('ledger-row-immutability: returned movement is frozen', async () => {
    const { assets, uc } = setup();
    await assets.create(
      createInventoryAsset({ id: 'A1', serialNumber: 'SN1', deviceTypeId: 'd1', currentLocationId: L_DEPOT, source: 'MANUAL', status: 'available' }),
    );
    const mv = await uc.execute({ type: 'INSTALL', assetId: 'A1', toLocationId: L_CLIENT, taskId: 'T1', source: 'X' });
    expect(Object.isFrozen(mv)).toBe(true);
    expect(() => {
      (mv as { note: string | null }).note = 'mutated';
    }).toThrow();
  });
});

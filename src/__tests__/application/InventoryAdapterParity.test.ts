import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { PrismaInventoryMovementRepository } from '@infrastructure/adapters/prisma/PrismaInventoryMovementRepository';
import { computeAssetEffect } from '@domain/entities/inventory-asset-effect';
import { createInventoryMovement } from '@domain/entities/inventory-movement';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import { roundQty } from '@domain/entities/material-stock';
import { RecordMovementInput } from '@domain/ports/InventoryMovementRepository';
import { prisma } from '@infrastructure/database/prisma';

/**
 * Fix #3 — PARITY: the SAME movement matrix must produce identical asset/material
 * post-states across the in-memory adapter and the Prisma adapter. Both must route
 * the asset effect through computeAssetEffect (no divergent hand-coded switches).
 *
 * Coverage ceiling (Fix Test-H3/M3, documented honestly): the Prisma arm runs
 * against a captured fake `$transaction` client, so it asserts the INTENT (the
 * exact asset.update payload / the material decrement+increment args) the adapter
 * issues — NOT a real Postgres re-read. The MATERIAL BALANCE parity is asserted
 * end-to-end on the in-memory adapter (which keeps a real materialized balance)
 * and the Prisma adapter's computed effect is asserted to match the same intent.
 * Real Postgres rollback/concurrency parity (TOCTOU under READ COMMITTED) is NOT
 * covered here — the repo has no pg-mem/testcontainer today; see the Prisma
 * repository test for the atomic-decrement intent assertions.
 */
describe('Adapter parity — asset effects through computeAssetEffect', () => {
  // Every asset verb the factory still allows (Fix M1 forbids asset CONSUME/ISSUE).
  const matrix: { name: string; input: RecordMovementInput; startStatus: 'available' | 'installed' }[] = [
    { name: 'INSTALL', input: { type: 'INSTALL', assetId: 'A1', toLocationId: 'L_client', source: 'X' }, startStatus: 'available' },
    { name: 'RETURN', input: { type: 'RETURN', assetId: 'A1', toLocationId: 'L_depot', source: 'X' }, startStatus: 'installed' },
    { name: 'TRANSFER', input: { type: 'TRANSFER', assetId: 'A1', fromLocationId: 'L1', toLocationId: 'L2', source: 'X' }, startStatus: 'available' },
    { name: 'ADJUST-status', input: { type: 'ADJUST', assetId: 'A1', status: 'damaged', note: 'broke', source: 'X' }, startStatus: 'installed' },
    { name: 'ADJUST-relocate', input: { type: 'ADJUST', assetId: 'A1', status: 'available', toLocationId: 'L_depot', note: 'relocate', source: 'X' }, startStatus: 'installed' },
  ];

  it.each(matrix)('$name: in-memory asset post-state matches computeAssetEffect', async ({ input, startStatus }) => {
    const assets = new InMemoryInventoryAssetRepository();
    const materials = new InMemoryMaterialStockRepository();
    const movements = new InMemoryInventoryMovementRepository(assets, materials);
    await assets.create(
      createInventoryAsset({ id: 'A1', serialNumber: 'SN', deviceTypeId: 'd', currentLocationId: 'L_start', source: 'X', status: startStatus }),
    );

    await movements.record(input);

    const expected = computeAssetEffect(
      createInventoryMovement({ id: 'expected', ...input } as never),
    );
    const a = (await assets.findById('A1'))!;
    if (expected.currentLocationId) expect(a.currentLocationId).toBe(expected.currentLocationId);
    else expect(a.currentLocationId).toBe('L_start');
    if (expected.status) expect(a.status).toBe(expected.status);
    else expect(a.status).toBe(startStatus);
  });

  it.each(matrix)('$name: Prisma asset.update payload matches computeAssetEffect', async ({ input }) => {
    const updateCalls: Record<string, unknown>[] = [];
    const tx = {
      inventoryAsset: {
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          updateCalls.push(data);
          return {};
        }),
      },
      materialStock: { findUnique: jest.fn(async () => ({ qty: 1000 })), upsert: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 1 })) },
      inventoryMovement: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, occurredAt: new Date(data.occurredAt as string) })),
      },
    };
    jest.spyOn(prisma, '$transaction').mockImplementation((async (cb: (t: unknown) => unknown) => cb(tx)) as never);

    const repo = new PrismaInventoryMovementRepository();
    await repo.record(input);

    const expected = computeAssetEffect(createInventoryMovement({ id: 'expected', ...input } as never));
    if (Object.keys(expected).length === 0) {
      expect(tx.inventoryAsset.update).not.toHaveBeenCalled();
    } else {
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]).toEqual(expected);
    }
    jest.restoreAllMocks();
  });
});

/**
 * Fix Test-H3/M3 — MATERIAL parity matrix. Adds the missing CONSUME case plus a
 * material movement and asserts the resulting MATERIAL BALANCE is identical across
 * adapters. The in-memory adapter holds the real materialized balance (source of
 * truth for the assertion); the Prisma adapter is asserted to issue the SAME
 * decrement/increment/set intent against its fake tx client.
 */
describe('Adapter parity — material balance through applyMaterialEffect', () => {
  const M = 'M1';
  const start = 100;

  // Each case: a material movement and the expected resulting balance at each location.
  const cases: {
    name: string;
    input: RecordMovementInput;
    seed: { loc: string; qty: number }[];
    expectBalances: Record<string, number>;
  }[] = [
    {
      name: 'CONSUME decrements fromLocation',
      input: { type: 'CONSUME', materialCatalogId: M, qty: 30, fromLocationId: 'L_depot', source: 'X' },
      seed: [{ loc: 'L_depot', qty: start }],
      expectBalances: { L_depot: 70 },
    },
    {
      name: 'ISSUE decrements fromLocation',
      input: { type: 'ISSUE', materialCatalogId: M, qty: 25, fromLocationId: 'L_depot', source: 'X' },
      seed: [{ loc: 'L_depot', qty: start }],
      expectBalances: { L_depot: 75 },
    },
    {
      name: 'TRANSFER moves between locations',
      input: { type: 'TRANSFER', materialCatalogId: M, qty: 40, fromLocationId: 'L_depot', toLocationId: 'L_tech', source: 'X' },
      seed: [{ loc: 'L_depot', qty: start }, { loc: 'L_tech', qty: 10 }],
      expectBalances: { L_depot: 60, L_tech: 50 },
    },
    {
      // FIX W1 cardinal: ADJUST(material) is now DELTA-additive. Ledger row qty = delta.
      // The depot entry use case (AddMaterialToDepot) passes the raw input qty as the
      // delta; both adapters apply it via increment (upsert additive). Two concurrent
      // loads both commit without a lost-update window.
      name: 'ADJUST adds delta to balance (DELTA-additive, FIX W1)',
      input: { type: 'ADJUST', materialCatalogId: M, qty: 7, toLocationId: 'L_depot', note: 'count', source: 'X' },
      seed: [{ loc: 'L_depot', qty: start }],
      expectBalances: { L_depot: 107 }, // 100 + 7 = 107
    },
    {
      // ADJUST with qty=0 is a no-op on the balance (delta=0 → increment(0) → unchanged).
      // Fix H2 allowed qty=0; with delta-additive semantics a zero-delta is idempotent.
      name: 'ADJUST delta=0 is a balance no-op (Fix H2, DELTA-additive)',
      input: { type: 'ADJUST', materialCatalogId: M, qty: 0, toLocationId: 'L_depot', note: 'counted zero', source: 'X' },
      seed: [{ loc: 'L_depot', qty: start }],
      expectBalances: { L_depot: 100 }, // 100 + 0 = 100 (no change)
    },
    {
      // Fix Test-H3/M3 — the INSTALL/RETURN increment fall-through branch
      // (PrismaInventoryMovementRepository:~182-185 ↔ InMemory:~89-94). A material
      // INSTALL/RETURN with a toLocationId is an additive restock-style increment.
      name: 'INSTALL increments toLocation (material fall-through)',
      input: { type: 'INSTALL', materialCatalogId: M, qty: 15, toLocationId: 'L_depot', source: 'X' },
      seed: [{ loc: 'L_depot', qty: start }],
      expectBalances: { L_depot: 115 },
    },
    {
      name: 'RETURN increments toLocation (material fall-through)',
      input: { type: 'RETURN', materialCatalogId: M, qty: 5, toLocationId: 'L_depot', source: 'X' },
      seed: [{ loc: 'L_depot', qty: start }],
      expectBalances: { L_depot: 105 },
    },
    {
      // Fix M2/Wave4 — sub-precision parity. Raw JS `0.1+0.2` is 0.30000000000000004;
      // both adapters MUST land bit-identical on the Decimal(12,4) value 0.3.
      name: 'INSTALL fractional qty rounds to 4dp (float parity)',
      input: { type: 'INSTALL', materialCatalogId: M, qty: 0.2, toLocationId: 'L_frac', source: 'X' },
      seed: [{ loc: 'L_frac', qty: 0.1 }],
      expectBalances: { L_frac: 0.3 },
    },
    {
      name: 'CONSUME fractional qty rounds to 4dp (float parity)',
      input: { type: 'CONSUME', materialCatalogId: M, qty: 0.1 + 0.2, fromLocationId: 'L_depot', source: 'X' },
      seed: [{ loc: 'L_depot', qty: start }],
      expectBalances: { L_depot: 99.7 },
    },
  ];

  it.each(cases)('$name: in-memory material balance is exact', async ({ input, seed, expectBalances }) => {
    const assets = new InMemoryInventoryAssetRepository();
    const materials = new InMemoryMaterialStockRepository();
    const movements = new InMemoryInventoryMovementRepository(assets, materials);
    for (const s of seed) {
      await materials.upsert({ id: '', materialCatalogId: M, locationId: s.loc, qty: s.qty });
    }

    await movements.record(input);

    for (const [loc, qty] of Object.entries(expectBalances)) {
      const row = await materials.findByMaterialAndLocation(M, loc);
      expect(row?.qty).toBe(qty);
    }
  });

  it.each(cases)('$name: Prisma issues the same material intent against its tx client', async ({ input }) => {
    const decrementArgs: { where: { locationId: string }; data: { qty: { decrement: number } } }[] = [];
    const upsertArgs: { where: unknown; update: Record<string, unknown>; create: Record<string, unknown> }[] = [];
    const tx = {
      inventoryAsset: { update: jest.fn(async () => ({})) },
      materialStock: {
        findUnique: jest.fn(async () => ({ qty: 1000 })),
        updateMany: jest.fn(async (a: { where: { locationId: string }; data: { qty: { decrement: number } } }) => {
          decrementArgs.push(a);
          return { count: 1 };
        }),
        upsert: jest.fn(async (a: { where: unknown; update: Record<string, unknown>; create: Record<string, unknown> }) => {
          upsertArgs.push(a);
          return {};
        }),
      },
      inventoryMovement: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, occurredAt: new Date(data.occurredAt as string) })),
      },
    };
    jest.spyOn(prisma, '$transaction').mockImplementation((async (cb: (t: unknown) => unknown) => cb(tx)) as never);

    const repo = new PrismaInventoryMovementRepository();
    await repo.record(input);

    const fromLoc = input.fromLocationId;
    const toLoc = input.toLocationId;
    if (input.type === 'CONSUME' || input.type === 'ISSUE') {
      expect(decrementArgs).toHaveLength(1);
      expect(decrementArgs[0].where.locationId).toBe(fromLoc);
      // Decimal-safe: the decrement value equals the requested qty rounded to 4dp.
      expect(Number(decrementArgs[0].data.qty.decrement)).toBe(roundQty(input.qty!));
    } else if (input.type === 'TRANSFER') {
      expect(decrementArgs).toHaveLength(1);
      expect(decrementArgs[0].where.locationId).toBe(fromLoc);
      expect(upsertArgs).toHaveLength(1);
      expect(Number((upsertArgs[0].update.qty as { increment: number }).increment)).toBe(roundQty(input.qty!));
    } else if (input.type === 'ADJUST') {
      expect(upsertArgs).toHaveLength(1);
      expect((upsertArgs[0].where as { materialCatalogId_locationId: { locationId: string } }).materialCatalogId_locationId.locationId).toBe(toLoc);
      // FIX W1: ADJUST(material) is now DELTA-additive — update.qty = { increment: delta }.
      expect(Number((upsertArgs[0].update.qty as { increment: number }).increment)).toBe(roundQty(input.qty!));
    } else if (input.type === 'INSTALL' || input.type === 'RETURN') {
      // Material INSTALL/RETURN fall-through → additive increment at toLocation.
      expect(upsertArgs).toHaveLength(1);
      expect((upsertArgs[0].where as { materialCatalogId_locationId: { locationId: string } }).materialCatalogId_locationId.locationId).toBe(toLoc);
      expect(Number((upsertArgs[0].update.qty as { increment: number }).increment)).toBe(roundQty(input.qty!));
    }
    jest.restoreAllMocks();
  });
});

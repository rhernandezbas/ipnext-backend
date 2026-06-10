import { PrismaInventoryMovementRepository } from '@infrastructure/adapters/prisma/PrismaInventoryMovementRepository';
import { RecordMovementInput } from '@domain/ports/InventoryMovementRepository';
import { prisma } from '@infrastructure/database/prisma';

/**
 * Transaction-boundary parity test. We do NOT mock Prisma-as-a-port; we assert
 * the adapter wraps the ledger write in prisma.$transaction and that its record()
 * accepts every movement type with the D2 port shape. A fake tx client captures
 * the calls so no real DB is touched.
 */
describe('PrismaInventoryMovementRepository — $transaction boundary', () => {
  function fakeTx() {
    const created: unknown[] = [];
    const tx = {
      inventoryAsset: { update: jest.fn(async () => ({})) },
      materialStock: {
        findUnique: jest.fn(async () => ({ qty: 1000 })),
        upsert: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      inventoryMovement: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { ...data, occurredAt: new Date(data.occurredAt as string) };
        }),
      },
    };
    return { tx, created };
  }

  afterEach(() => jest.restoreAllMocks());

  it('record() wraps the write in prisma.$transaction', async () => {
    const { tx } = fakeTx();
    const spy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementation((async (cb: (t: unknown) => unknown) => cb(tx)) as never);

    const repo = new PrismaInventoryMovementRepository();
    await repo.record({
      type: 'INSTALL',
      assetId: 'A1',
      toLocationId: 'L_client',
      taskId: 'T1',
      source: 'ICLASS',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(tx.inventoryMovement.create).toHaveBeenCalledTimes(1);
    expect(tx.inventoryAsset.update).toHaveBeenCalled();
  });

  it('record() accepts all 6 movement types (port shape parity)', async () => {
    const { tx } = fakeTx();
    jest
      .spyOn(prisma, '$transaction')
      .mockImplementation((async (cb: (t: unknown) => unknown) => cb(tx)) as never);
    const repo = new PrismaInventoryMovementRepository();

    const inputs: RecordMovementInput[] = [
      { type: 'INSTALL', assetId: 'A1', toLocationId: 'L2', source: 'X' },
      { type: 'RETURN', assetId: 'A1', toLocationId: 'L1', source: 'X' },
      { type: 'ISSUE', materialCatalogId: 'M1', qty: 1, fromLocationId: 'L1', source: 'X' },
      { type: 'TRANSFER', materialCatalogId: 'M1', qty: 1, fromLocationId: 'L1', toLocationId: 'L2', source: 'X' },
      { type: 'CONSUME', materialCatalogId: 'M1', qty: 1, fromLocationId: 'L1', source: 'X' },
      { type: 'ADJUST', materialCatalogId: 'M1', qty: 5, toLocationId: 'L1', note: 'n', source: 'X' },
    ];

    for (const input of inputs) {
      const mv = await repo.record(input);
      expect(mv.type).toBe(input.type);
    }
    expect(tx.inventoryMovement.create).toHaveBeenCalledTimes(6);
  });

  it('CONSUME with insufficient stock throws InsufficientStockError (rolls back, no movement created)', async () => {
    const { tx, created } = fakeTx();
    tx.materialStock.findUnique = jest.fn(async () => ({ qty: 3 }));
    tx.materialStock.updateMany = jest.fn(async () => ({ count: 0 }));
    jest
      .spyOn(prisma, '$transaction')
      .mockImplementation((async (cb: (t: unknown) => unknown) => cb(tx)) as never);
    const repo = new PrismaInventoryMovementRepository();

    await expect(
      repo.record({ type: 'CONSUME', materialCatalogId: 'M1', qty: 10, fromLocationId: 'L1', source: 'X' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(created).toHaveLength(0);
  });

  // ── Fix #1/#2 — atomic conditional decrement, no TOCTOU, no negative-create ──
  it('CONSUME uses an atomic conditional updateMany (qty gte amount), no read-then-write', async () => {
    const updateManyArgs: Record<string, unknown>[] = [];
    const tx = {
      inventoryAsset: { update: jest.fn(async () => ({})) },
      materialStock: {
        findUnique: jest.fn(async () => ({ qty: 50 })),
        upsert: jest.fn(async () => ({})),
        updateMany: jest.fn(async (args: Record<string, unknown>) => {
          updateManyArgs.push(args);
          return { count: 1 };
        }),
      },
      inventoryMovement: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, occurredAt: new Date(data.occurredAt as string) })),
      },
    };
    jest.spyOn(prisma, '$transaction').mockImplementation((async (cb: (t: unknown) => unknown) => cb(tx)) as never);

    const repo = new PrismaInventoryMovementRepository();
    await repo.record({ type: 'CONSUME', materialCatalogId: 'M1', qty: 5, fromLocationId: 'L1', source: 'X' });

    expect(tx.materialStock.updateMany).toHaveBeenCalledTimes(1);
    const arg = updateManyArgs[0] as { where: { qty: { gte: unknown } }; data: { qty: { decrement: unknown } } };
    // Fix M2: values are now Decimal-safe — compare numerically.
    expect(Number(arg.where.qty.gte)).toBe(5);
    expect(Number(arg.data.qty.decrement)).toBe(5);
    jest.restoreAllMocks();
  });

  it('CONSUME with count===0 from the conditional update throws InsufficientStockError (no negative write)', async () => {
    const tx = {
      inventoryAsset: { update: jest.fn(async () => ({})) },
      materialStock: {
        findUnique: jest.fn(async () => ({ qty: 3 })),
        upsert: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      inventoryMovement: { create: jest.fn(async () => ({})) },
    };
    jest.spyOn(prisma, '$transaction').mockImplementation((async (cb: (t: unknown) => unknown) => cb(tx)) as never);

    const repo = new PrismaInventoryMovementRepository();
    await expect(
      repo.record({ type: 'CONSUME', materialCatalogId: 'M1', qty: 10, fromLocationId: 'L1', source: 'X' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('CONSUME on a missing stock row never creates a negative-qty row (count===0 → throws)', async () => {
    const upsertCalls: unknown[] = [];
    const tx = {
      inventoryAsset: { update: jest.fn(async () => ({})) },
      materialStock: {
        findUnique: jest.fn(async () => null),
        upsert: jest.fn(async (a: unknown) => {
          upsertCalls.push(a);
          return {};
        }),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      inventoryMovement: { create: jest.fn(async () => ({})) },
    };
    jest.spyOn(prisma, '$transaction').mockImplementation((async (cb: (t: unknown) => unknown) => cb(tx)) as never);

    const repo = new PrismaInventoryMovementRepository();
    await expect(
      repo.record({ type: 'CONSUME', materialCatalogId: 'M1', qty: 1, fromLocationId: 'L1', source: 'X' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    expect(upsertCalls).toHaveLength(0); // never tried to create a (negative) row
    jest.restoreAllMocks();
  });

  // ── Fix M2 — Decimal write-side: a binary-float qty must NOT reach Postgres ──
  it('CONSUME of a fractional qty (0.1+0.2) decrements with a Decimal-safe 4dp value, not binary float', async () => {
    const { Prisma } = await import('@prisma/client');
    const updateManyArgs: { data: { qty: { decrement: unknown } } }[] = [];
    const tx = {
      inventoryAsset: { update: jest.fn(async () => ({})) },
      materialStock: {
        findUnique: jest.fn(async () => ({ qty: 1000 })),
        upsert: jest.fn(async () => ({})),
        updateMany: jest.fn(async (a: { data: { qty: { decrement: unknown } } }) => {
          updateManyArgs.push(a);
          return { count: 1 };
        }),
      },
      inventoryMovement: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, occurredAt: new Date(data.occurredAt as string) })),
      },
    };
    jest.spyOn(prisma, '$transaction').mockImplementation((async (cb: (t: unknown) => unknown) => cb(tx)) as never);

    const repo = new PrismaInventoryMovementRepository();
    await repo.record({ type: 'CONSUME', materialCatalogId: 'M1', qty: 0.1 + 0.2, fromLocationId: 'L1', source: 'X' });

    const decrement = updateManyArgs[0].data.qty.decrement;
    // Must be a Prisma.Decimal, NOT a raw JS number carrying 0.30000000000000004.
    expect(Prisma.Decimal.isDecimal(decrement)).toBe(true);
    expect((decrement as InstanceType<typeof Prisma.Decimal>).toString()).toBe('0.3');
    jest.restoreAllMocks();
  });

  it('ADJUST writes a Decimal-safe delta increment (no float drift, FIX W1 DELTA-additive)', async () => {
    // FIX W1: ADJUST(material) is now DELTA-additive. The Prisma adapter issues
    // update: { qty: { increment: Decimal(delta) } } NOT update: { qty: Decimal(set) }.
    const { Prisma } = await import('@prisma/client');
    const upsertArgs: { update: { qty: { increment: unknown } } }[] = [];
    const tx = {
      inventoryAsset: { update: jest.fn(async () => ({})) },
      materialStock: {
        findUnique: jest.fn(async () => ({ qty: 1000 })),
        upsert: jest.fn(async (a: { update: { qty: { increment: unknown } } }) => {
          upsertArgs.push(a);
          return {};
        }),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      inventoryMovement: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, occurredAt: new Date(data.occurredAt as string) })),
      },
    };
    jest.spyOn(prisma, '$transaction').mockImplementation((async (cb: (t: unknown) => unknown) => cb(tx)) as never);

    const repo = new PrismaInventoryMovementRepository();
    await repo.record({ type: 'ADJUST', materialCatalogId: 'M1', qty: 0.1 + 0.2, toLocationId: 'L1', note: 'count', source: 'X' });

    // The update payload must be { increment: Decimal('0.3') } — not a raw SET value.
    const increment = upsertArgs[0].update.qty.increment;
    expect(Prisma.Decimal.isDecimal(increment)).toBe(true);
    expect((increment as InstanceType<typeof Prisma.Decimal>).toString()).toBe('0.3');
    jest.restoreAllMocks();
  });

  it('rejects a bad-shape movement (asset + material) before opening the transaction', async () => {
    const spy = jest.spyOn(prisma, '$transaction');
    const repo = new PrismaInventoryMovementRepository();

    await expect(
      repo.record({ type: 'INSTALL', assetId: 'A1', materialCatalogId: 'M1', qty: 1, source: 'X' }),
    ).rejects.toMatchObject({ code: 'INCONSISTENT_MOVEMENT' });
    expect(spy).not.toHaveBeenCalled();
  });
});

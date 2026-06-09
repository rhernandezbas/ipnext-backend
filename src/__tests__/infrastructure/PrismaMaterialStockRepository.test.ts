import { PrismaMaterialStockRepository } from '@infrastructure/adapters/prisma/PrismaMaterialStockRepository';
import { prisma } from '@infrastructure/database/prisma';

/**
 * Fix #1/#2 — PrismaMaterialStockRepository.decrement must use an ATOMIC conditional
 * update (qty >= amount), eliminating the read-then-write TOCTOU window, and must
 * NEVER create a negative-qty row when the stock row is missing/insufficient.
 */
describe('PrismaMaterialStockRepository.decrement — atomic, no TOCTOU, no negative-create', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses updateMany with qty gte amount (atomic conditional, no findUnique-then-write)', async () => {
    const updateManyArgs: Record<string, unknown>[] = [];
    jest.spyOn(prisma.materialStock, 'updateMany').mockImplementation((async (args: Record<string, unknown>) => {
      updateManyArgs.push(args);
      return { count: 1 };
    }) as never);
    jest.spyOn(prisma.materialStock, 'findUnique').mockImplementation((async () => ({ id: 's', materialCatalogId: 'M1', locationId: 'L1', qty: 5 })) as never);

    const repo = new PrismaMaterialStockRepository();
    const res = await repo.decrement('M1', 'L1', 4);

    expect(prisma.materialStock.updateMany).toHaveBeenCalledTimes(1);
    const arg = updateManyArgs[0] as { where: { qty: { gte: unknown } }; data: { qty: { decrement: unknown } } };
    expect(Number(arg.where.qty.gte)).toBe(4);
    expect(Number(arg.data.qty.decrement)).toBe(4);
    expect(res.qty).toBe(5); // re-read post-state
  });

  it('throws InsufficientStockError (no row created) when count===0', async () => {
    jest.spyOn(prisma.materialStock, 'updateMany').mockImplementation((async () => ({ count: 0 })) as never);
    jest.spyOn(prisma.materialStock, 'findUnique').mockImplementation((async () => null) as never);
    const upsertSpy = jest.spyOn(prisma.materialStock, 'upsert').mockImplementation((async () => ({})) as never);

    const repo = new PrismaMaterialStockRepository();
    await expect(repo.decrement('M1', 'L1', 10)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(upsertSpy).not.toHaveBeenCalled(); // never creates a negative row
  });
});

/**
 * Fix W-DimA — PrismaMaterialStockRepository must accept an injected client
 * (constructor(db = prisma)) so it can join an outer UnitOfWork transaction,
 * matching its 4 sibling inventory repos. Default stays the global `prisma`.
 */
describe('PrismaMaterialStockRepository — client injection (Fix W-DimA)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the INJECTED client (not the global prisma) for every operation', async () => {
    const injected = {
      materialStock: {
        findUnique: jest.fn(async () => ({ id: 's', materialCatalogId: 'M1', locationId: 'L1', qty: 9 })),
        upsert: jest.fn(async () => ({ id: 's', materialCatalogId: 'M1', locationId: 'L1', qty: 9 })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const globalUpsert = jest.spyOn(prisma.materialStock, 'upsert');
    const globalFind = jest.spyOn(prisma.materialStock, 'findUnique');

    const repo = new PrismaMaterialStockRepository(injected as never);
    await repo.findByMaterialAndLocation('M1', 'L1');
    await repo.upsert({ id: 's', materialCatalogId: 'M1', locationId: 'L1', qty: 9 });
    await repo.increment('M1', 'L1', 2);
    await repo.decrement('M1', 'L1', 1);

    expect(injected.materialStock.findUnique).toHaveBeenCalled();
    expect(injected.materialStock.upsert).toHaveBeenCalled();
    expect(injected.materialStock.updateMany).toHaveBeenCalled();
    // The global client must never be touched when a client is injected.
    expect(globalUpsert).not.toHaveBeenCalled();
    expect(globalFind).not.toHaveBeenCalled();
  });
});

/**
 * Fix M2 — Decimal write-side: PrismaMaterialStockRepository must convert qty to a
 * Decimal-safe 4dp value at the write boundary so no binary float reaches the
 * Decimal(12,4) column.
 */
describe('PrismaMaterialStockRepository — Decimal-safe writes (Fix M2)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('increment passes a Prisma.Decimal (no float drift) for a fractional amount', async () => {
    const { Prisma } = await import('@prisma/client');
    const upsertArgs: { update: { qty: { increment: unknown } }; create: { qty: unknown } }[] = [];
    const injected = {
      materialStock: {
        upsert: jest.fn(async (a: { update: { qty: { increment: unknown } }; create: { qty: unknown } }) => {
          upsertArgs.push(a);
          return { id: 's', materialCatalogId: 'M1', locationId: 'L1', qty: 0 };
        }),
        findUnique: jest.fn(async () => null),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const repo = new PrismaMaterialStockRepository(injected as never);
    await repo.increment('M1', 'L1', 0.1 + 0.2);

    const inc = upsertArgs[0].update.qty.increment;
    expect(Prisma.Decimal.isDecimal(inc)).toBe(true);
    expect((inc as InstanceType<typeof Prisma.Decimal>).toString()).toBe('0.3');
  });

  it('decrement passes a Prisma.Decimal for both the gte guard and the decrement', async () => {
    const { Prisma } = await import('@prisma/client');
    const args: { where: { qty: { gte: unknown } }; data: { qty: { decrement: unknown } } }[] = [];
    const injected = {
      materialStock: {
        updateMany: jest.fn(async (a: { where: { qty: { gte: unknown } }; data: { qty: { decrement: unknown } } }) => {
          args.push(a);
          return { count: 1 };
        }),
        findUnique: jest.fn(async () => ({ id: 's', materialCatalogId: 'M1', locationId: 'L1', qty: 5 })),
        upsert: jest.fn(async () => ({})),
      },
    };
    const repo = new PrismaMaterialStockRepository(injected as never);
    await repo.decrement('M1', 'L1', 0.1 + 0.2);

    expect(Prisma.Decimal.isDecimal(args[0].where.qty.gte)).toBe(true);
    expect(Prisma.Decimal.isDecimal(args[0].data.qty.decrement)).toBe(true);
    expect((args[0].data.qty.decrement as InstanceType<typeof Prisma.Decimal>).toString()).toBe('0.3');
  });
});

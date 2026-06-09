import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';

/**
 * Fix L1 — the in-memory adapter must match the Prisma "never create on
 * decrement" invariant: a decrement against a missing or insufficient stock row
 * throws InsufficientStockError BEFORE any write and leaves the store untouched.
 * (The previous unreachable negative-create branch is removed.)
 */
describe('InMemoryMaterialStockRepository.decrement — never creates a row (Fix L1)', () => {
  it('decrement on a MISSING row throws and creates nothing', async () => {
    const repo = new InMemoryMaterialStockRepository();

    await expect(repo.decrement('M1', 'L1', 5)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    // No phantom row was created.
    expect(repo.store.size).toBe(0);
    expect(await repo.findByMaterialAndLocation('M1', 'L1')).toBeNull();
  });

  it('decrement BELOW zero on an existing row throws and leaves the balance unchanged', async () => {
    const repo = new InMemoryMaterialStockRepository();
    await repo.upsert({ id: '', materialCatalogId: 'M1', locationId: 'L1', qty: 3 });

    await expect(repo.decrement('M1', 'L1', 10)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    const row = await repo.findByMaterialAndLocation('M1', 'L1');
    expect(row?.qty).toBe(3); // untouched
  });

  it('decrement to exactly zero succeeds', async () => {
    const repo = new InMemoryMaterialStockRepository();
    await repo.upsert({ id: '', materialCatalogId: 'M1', locationId: 'L1', qty: 5 });

    const res = await repo.decrement('M1', 'L1', 5);

    expect(res.qty).toBe(0);
  });
});

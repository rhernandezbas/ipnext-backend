import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { createStockLocation } from '@domain/entities/stock-location';

describe('ResolveDepotLocation', () => {
  it('depot-already-exists: returns the same id, no duplicate', async () => {
    const repo = new InMemoryStockLocationRepository();
    const existing = await repo.create(
      createStockLocation({ id: 'L1', type: 'DEPOSITO', code: 'DEPOSITO' }),
    );
    const uc = new ResolveDepotLocation(repo);

    const loc = await uc.execute('DEPOSITO');

    expect(loc.id).toBe(existing.id);
    expect(repo.store.size).toBe(1);
  });

  it('depot-does-not-exist-yet: creates and returns a new DEPOSITO', async () => {
    const repo = new InMemoryStockLocationRepository();
    const uc = new ResolveDepotLocation(repo);

    const loc = await uc.execute('DEPOSITO');

    expect(loc.type).toBe('DEPOSITO');
    expect(loc.code).toBe('DEPOSITO');
    expect(repo.store.size).toBe(1);
  });

  it('idempotent: two calls return the same location', async () => {
    const repo = new InMemoryStockLocationRepository();
    const uc = new ResolveDepotLocation(repo);

    const a = await uc.execute('DEPOSITO');
    const b = await uc.execute('DEPOSITO');

    expect(a.id).toBe(b.id);
    expect(repo.store.size).toBe(1);
  });

  it('survives the P2002 create race: re-finds and returns the competitor depot', async () => {
    const locations = new InMemoryStockLocationRepository();
    // Simulate the race: first find misses; create throws a P2002-shaped error
    // AFTER a competitor inserted the depot, so the retry find succeeds.
    let created = false;
    const racing = {
      findByCode: async (code: string) => {
        return locations.findByCode(code);
      },
      findByTypeAndContract: locations.findByTypeAndContract.bind(locations),
      findByTypeAndTechnician: locations.findByTypeAndTechnician.bind(locations),
      create: async (loc: ReturnType<typeof createStockLocation>) => {
        if (!created) {
          created = true;
          // competitor wins: insert directly, then this create "fails" with P2002.
          await locations.create(
            createStockLocation({ id: 'winner', type: 'DEPOSITO', code: 'DEPOSITO' }),
          );
          const e: Error & { code?: string } = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        }
        return locations.create(loc);
      },
    };
    const uc = new ResolveDepotLocation(racing as never);

    const result = await uc.execute('DEPOSITO');

    expect(result.id).toBe('winner');
  });
});

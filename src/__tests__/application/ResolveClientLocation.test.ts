import { ResolveClientLocation } from '@application/use-cases/ResolveClientLocation';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { createStockLocation } from '@domain/entities/stock-location';

describe('ResolveClientLocation', () => {
  it('resolve-existing-client-location: returns the existing id, no duplicate', async () => {
    const repo = new InMemoryStockLocationRepository();
    const existing = await repo.create(
      createStockLocation({ id: 'L1', type: 'CLIENTE', contractId: 'C1' }),
    );
    const uc = new ResolveClientLocation(repo);

    const loc = await uc.execute('C1');

    expect(loc.id).toBe(existing.id);
    expect(repo.store.size).toBe(1);
  });

  it('creates a CLIENTE location when none exists for the contract', async () => {
    const repo = new InMemoryStockLocationRepository();
    const uc = new ResolveClientLocation(repo);

    const loc = await uc.execute('C1');

    expect(loc.type).toBe('CLIENTE');
    expect(loc.contractId).toBe('C1');
    expect(repo.store.size).toBe(1);
  });

  it('cliente-location-unique-per-contract: C1 and C2 are distinct, C1 resolves only C1', async () => {
    const repo = new InMemoryStockLocationRepository();
    const uc = new ResolveClientLocation(repo);

    const c1 = await uc.execute('C1');
    const c2 = await uc.execute('C2');
    const c1Again = await uc.execute('C1');

    expect(c1.id).not.toBe(c2.id);
    expect(c1Again.id).toBe(c1.id);
    expect(repo.store.size).toBe(2);
  });
});

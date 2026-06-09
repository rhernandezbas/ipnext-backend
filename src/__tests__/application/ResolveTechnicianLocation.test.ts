import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { createStockLocation } from '@domain/entities/stock-location';
import { StockLocation } from '@domain/entities/stock-location';

describe('ResolveTechnicianLocation', () => {
  it('returns the existing TECNICO location for the technician (idempotent)', async () => {
    const locations = new InMemoryStockLocationRepository();
    const existing = await locations.create(
      createStockLocation({ id: 'tec-1', type: 'TECNICO', technicianId: 't-42' }),
    );
    const useCase = new ResolveTechnicianLocation(locations);

    const result = await useCase.execute('t-42');

    expect(result.id).toBe(existing.id);
    expect(result.type).toBe('TECNICO');
    expect(result.technicianId).toBe('t-42');
    expect(locations.store.size).toBe(1);
  });

  it('creates a new TECNICO location when none exists for the technician', async () => {
    const locations = new InMemoryStockLocationRepository();
    const useCase = new ResolveTechnicianLocation(locations);

    const result = await useCase.execute('t-99');

    expect(result.type).toBe('TECNICO');
    expect(result.technicianId).toBe('t-99');
    expect(result.id).toBeTruthy();
    const stored = await locations.findByTypeAndTechnician('TECNICO', 't-99');
    expect(stored).not.toBeNull();
  });

  it('calling twice for the same technician returns the same location (find-or-create)', async () => {
    const locations = new InMemoryStockLocationRepository();
    const useCase = new ResolveTechnicianLocation(locations);

    const first = await useCase.execute('t-7');
    const second = await useCase.execute('t-7');

    expect(second.id).toBe(first.id);
    expect(locations.store.size).toBe(1);
  });

  it('on a P2002 race (concurrent create) retries the find and returns the winner', async () => {
    const locations = new InMemoryStockLocationRepository();
    // Simulate the race: the first find misses, but by the time create() runs a
    // competitor has inserted the winning row. create() rejects with P2002, and
    // the use case must re-run the find and return the competitor's row.
    let winner: StockLocation | null = null;
    const originalCreate = locations.create.bind(locations);
    jest.spyOn(locations, 'create').mockImplementationOnce(async (loc) => {
      // a competitor wins the race first
      winner = await originalCreate(
        createStockLocation({ id: 'winner-loc', type: 'TECNICO', technicianId: loc.technicianId! }),
      );
      const err = new Error('unique constraint') as Error & { code: string };
      err.code = 'P2002';
      throw err;
    });

    const useCase = new ResolveTechnicianLocation(locations);
    const result = await useCase.execute('t-race');

    expect(winner).not.toBeNull();
    expect(result.id).toBe('winner-loc');
  });

  it('rethrows a non-P2002 error from create', async () => {
    const locations = new InMemoryStockLocationRepository();
    jest.spyOn(locations, 'create').mockRejectedValueOnce(new Error('db down'));
    const useCase = new ResolveTechnicianLocation(locations);

    await expect(useCase.execute('t-boom')).rejects.toThrow('db down');
  });
});

/**
 * SCEN-CL-1..3 — ResolveVehicleLocation use-case tests (EPIC #38, Wave 5b).
 * In-memory repos only; no Prisma.
 */
import { ResolveVehicleLocation } from '@application/use-cases/ResolveVehicleLocation';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { createStockLocation } from '@domain/entities/stock-location';
import { MissingLocationFkError } from '@domain/errors/inventory';

describe('ResolveVehicleLocation', () => {
  function makeUC(locations: InMemoryStockLocationRepository) {
    return new ResolveVehicleLocation(locations);
  }

  // SCEN-CL-1: creates a new CAMIONETA location when none exists
  it('SCEN-CL-1: creates CAMIONETA location for new vehicle', async () => {
    const locations = new InMemoryStockLocationRepository();
    const uc = makeUC(locations);
    const loc = await uc.execute('V1');
    expect(loc.type).toBe('CAMIONETA');
    expect(loc.vehicleId).toBe('V1');
    expect(loc.id).toBeDefined();
    // Persisted in store
    expect(locations.store.size).toBe(1);
  });

  // SCEN-CL-2: idempotent — returns same location on second call
  it('SCEN-CL-2: resolve is idempotent for existing location', async () => {
    const locations = new InMemoryStockLocationRepository();
    const uc = makeUC(locations);
    const first = await uc.execute('V1');
    const second = await uc.execute('V1');
    expect(second.id).toBe(first.id);
    expect(locations.store.size).toBe(1);
  });

  // SCEN-CL-3: factory rejects CAMIONETA without vehicleId → MissingLocationFkError
  it('SCEN-CL-3: createStockLocation({ type: CAMIONETA, vehicleId: null }) throws MissingLocationFkError', () => {
    expect(() => createStockLocation({ id: 'x', type: 'CAMIONETA', vehicleId: null })).toThrow(MissingLocationFkError);
  });
});

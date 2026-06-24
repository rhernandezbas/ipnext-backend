/**
 * EnsureInternetContractService — escenarios de eventos (pppoe-baja-motivo).
 *
 * TDD: escrito ANTES de la implementación.
 *
 * Escenarios:
 *   - active=false + línea active → registra 'deactivated' con reason+actor
 *   - active=true + sin línea → registra 'activated' (reason null, actor from opts)
 *   - active=true + línea inactive → registra 'activated' (reactivación)
 *   - active=true + línea ya active → NO registra evento (no-op)
 *   - active=false + sin línea → NO registra evento (no-op)
 *   - eventRepo.record() lanza → no rompe execute() (best-effort)
 *   - eventRepo ausente (undefined) → funciona normal sin registrar nada
 */
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';

async function seedInternetCatalog(catalogRepo: InMemoryServiceCatalogRepository, active = true) {
  return catalogRepo.create({ name: 'INTERNET', label: 'Internet', active, sortOrder: 1 });
}

describe('EnsureInternetContractService — eventos (pppoe-baja-motivo)', () => {
  let csRepo: InMemoryContractServiceRepository;
  let catalogRepo: InMemoryServiceCatalogRepository;
  let eventRepo: InMemoryContractServiceEventRepository;

  beforeEach(() => {
    csRepo = new InMemoryContractServiceRepository();
    catalogRepo = new InMemoryServiceCatalogRepository();
    eventRepo = new InMemoryContractServiceEventRepository();
  });

  // ── inactivar (baja/desasociar) ───────────────────────────────────────────

  it('active=false + línea active → registra deactivated con reason+actor', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });

    const uc = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);
    await uc.execute('C1', false, { reason: 'baja voluntaria', actorId: 'A1', actorName: 'Admin' });

    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.reason).toBe('baja voluntaria');
    expect(events[0]!.actorId).toBe('A1');
    expect(events[0]!.actorName).toBe('Admin');
    expect(events[0]!.contractId).toBe('C1');
    expect(events[0]!.serviceCatalogId).toBe(catalog.id);
  });

  it('active=false + reason null → registra deactivated con reason=null', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });

    const uc = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);
    await uc.execute('C1', false, { reason: null, actorId: null, actorName: '' });

    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.reason).toBeNull();
  });

  it('active=false + sin línea → NO registra evento (no-op)', async () => {
    await seedInternetCatalog(catalogRepo);
    const uc = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);
    await uc.execute('C1', false, { reason: 'motivo', actorId: 'A1', actorName: 'Admin' });

    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(0);
  });

  it('active=false + línea ya inactive → NO registra evento (no-op)', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    const cs = await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });
    await csRepo.update(cs.id, { status: 'inactive' });

    const uc = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);
    await uc.execute('C1', false, { reason: 'motivo', actorId: 'A1', actorName: 'Admin' });

    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(0);
  });

  // ── activar (alta/asociar) ────────────────────────────────────────────────

  it('active=true + sin línea → registra activated con actor', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };

    const uc = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);
    await uc.execute('C1', true, { actorId: 'A2', actorName: 'Operador' });

    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('activated');
    expect(events[0]!.reason).toBeNull();
    expect(events[0]!.actorId).toBe('A2');
    expect(events[0]!.actorName).toBe('Operador');
  });

  it('active=true + línea inactive → registra activated (reactivación)', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    const cs = await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });
    await csRepo.update(cs.id, { status: 'inactive' });

    const uc = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);
    await uc.execute('C1', true, { actorId: 'A1', actorName: 'Admin' });

    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('activated');
  });

  it('active=true + línea ya active → NO registra evento (no-op)', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });

    const uc = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);
    await uc.execute('C1', true, { actorId: 'A1', actorName: 'Admin' });

    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(0);
  });

  // ── best-effort ───────────────────────────────────────────────────────────

  it('eventRepo.record() lanza → execute() no lanza (best-effort)', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });

    // eventRepo que lanza
    const failingEventRepo = {
      record: async () => { throw new Error('DB down'); },
      listByContract: async () => [],
      list: async () => [],
    };

    const uc = new EnsureInternetContractService(csRepo, catalogRepo, failingEventRepo);
    // Returns true (transition occurred) even when event recording fails — does not throw.
    await expect(uc.execute('C1', false, { reason: 'motivo' })).resolves.toBe(true);
  });

  // ── backward compat: sin eventRepo ───────────────────────────────────────

  it('sin eventRepo (undefined) → funciona normal, sin eventos', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });

    const uc = new EnsureInternetContractService(csRepo, catalogRepo); // sin eventRepo
    // Returns true (transition occurred), does not throw.
    await expect(uc.execute('C1', false, { reason: 'motivo' })).resolves.toBe(true);
  });

  it('sin opts → funciona normal, sin eventos', async () => {
    const catalog = await seedInternetCatalog(catalogRepo);
    csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
    await csRepo.add({ contractId: 'C1', serviceCatalogId: catalog.id });

    const uc = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);
    await uc.execute('C1', false); // sin opts
    // La baja ocurre pero como no hay reason/actorId, igual debe registrar deactivated
    // (los opts son opcionales pero la transición SI debe registrarse con los valores que llegan)
    const events = await eventRepo.listByContract('C1');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.reason).toBeNull();
    expect(events[0]!.actorId).toBeNull();
  });
});

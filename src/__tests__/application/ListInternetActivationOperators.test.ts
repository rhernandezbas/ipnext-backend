/**
 * TDD — ListInternetActivationOperators (internet-history "operadores").
 *
 * Espejo de ListInternetServiceHistory: en vez de los eventos, devuelve los OPERADORES
 * DISTINCT ({actorId, actorName}) que produjeron eventos del servicio INTERNET. Habilita
 * el <select> de operadores del historial con gate pppoe.read (sin admin/rbac).
 *
 * CRITICAL: SOLO operadores de eventos del servicio INTERNET — nunca TV ni otros. INTERNET
 * se identifica por ServiceCatalog.name === 'INTERNET'; el use case resuelve su catalog id
 * via ServiceCatalogRepository.getByName('INTERNET') y lo pasa como serviceCatalogId filter.
 * Si falta el catálogo INTERNET → [] (falla-cerrado).
 *
 * Usa adapters in-memory (use case REAL, sin mocks de Prisma).
 */
import { ListInternetActivationOperators } from '@application/use-cases/ListInternetActivationOperators';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

async function setup(opts?: { now?: () => Date }) {
  const catalog = new InMemoryServiceCatalogRepository();
  const internet = await catalog.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
  const tv = await catalog.create({ name: 'TV', label: 'TV', sortOrder: 1 });
  const eventRepo = new InMemoryContractServiceEventRepository(opts);
  const useCase = new ListInternetActivationOperators(eventRepo, catalog);
  return { catalog, internet, tv, eventRepo, useCase };
}

describe('ListInternetActivationOperators — distinct operators of internet events (internet-history)', () => {
  it('returns empty array when there are no events', async () => {
    const { useCase } = await setup();
    const res = await useCase.execute();
    expect(res).toEqual([]);
  });

  it('dedups: one operator with N events → 1 row', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a1', actorName: 'Op1' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'deactivated', actorId: 'a1', actorName: 'Op1' });
    await eventRepo.record({ contractId: 'ct-3', serviceCatalogId: internet.id, eventType: 'reactivated', actorId: 'a1', actorName: 'Op1' });

    const res = await useCase.execute();
    expect(res).toEqual([{ actorId: 'a1', actorName: 'Op1' }]);
  });

  it('excludes events with null/absent actorId', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a1', actorName: 'Op1' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'activated', actorId: null, actorName: 'Sin actor' });
    await eventRepo.record({ contractId: 'ct-3', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Sin id' });

    const res = await useCase.execute();
    expect(res).toEqual([{ actorId: 'a1', actorName: 'Op1' }]);
  });

  it('returns ONLY internet operators — excludes TV and other-service operators', async () => {
    const { useCase, eventRepo, internet, tv } = await setup();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a1', actorName: 'OpInternet' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: tv.id, eventType: 'activated', actorId: 'a2', actorName: 'OpTv' });
    await eventRepo.record({ contractId: 'ct-3', serviceCatalogId: 'other-svc', eventType: 'activated', actorId: 'a3', actorName: 'OpOther' });

    const res = await useCase.execute();
    expect(res).toEqual([{ actorId: 'a1', actorName: 'OpInternet' }]);
  });

  it('orders operators by actorName asc', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a1', actorName: 'Zulema' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a2', actorName: 'Ana' });
    await eventRepo.record({ contractId: 'ct-3', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a3', actorName: 'Maria' });

    const res = await useCase.execute();
    expect(res.map(o => o.actorName)).toEqual(['Ana', 'Maria', 'Zulema']);
  });

  it('on rename, returns the MOST RECENT actorName for the operator (deterministic)', async () => {
    let tick = 0;
    const times = [new Date('2026-07-21T09:00:00.000Z'), new Date('2026-07-21T10:00:00.000Z')];
    const { useCase, eventRepo, internet } = await setup({ now: () => times[tick++]! });
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a1', actorName: 'Nombre Viejo' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'reactivated', actorId: 'a1', actorName: 'Nombre Nuevo' });

    const res = await useCase.execute();
    expect(res).toEqual([{ actorId: 'a1', actorName: 'Nombre Nuevo' }]);
  });

  it('ignores empty-name events → NEVER yields a blank option (regression: distinct sin orderBy)', async () => {
    // El bug del review: el snapshot actorName tiene @default("") en el schema; un evento con
    // nombre vacío NO debe producir una opción en blanco ni pisar el nombre real del operador.
    // El vacío es el evento MÁS RECIENTE (t=10:00) — así el test ejerce de verdad el skip-empty:
    // con sola "recencia" (sin saltar vacíos) el más reciente sería '' → opción en blanco → falla.
    let tick = 0;
    const times = [new Date('2026-07-21T09:00:00.000Z'), new Date('2026-07-21T10:00:00.000Z')];
    const { useCase, eventRepo, internet } = await setup({ now: () => times[tick++]! });
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a1', actorName: 'Operador Real' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'deactivated', actorId: 'a1', actorName: '' });

    const res = await useCase.execute();
    expect(res).toEqual([{ actorId: 'a1', actorName: 'Operador Real' }]);
    expect(res.some(o => o.actorName === '')).toBe(false);
  });

  it('returns empty array when the INTERNET catalog entry is missing (no operators leak)', async () => {
    const catalog = new InMemoryServiceCatalogRepository();
    await catalog.create({ name: 'TV', label: 'TV', sortOrder: 0 });
    const eventRepo = new InMemoryContractServiceEventRepository();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: 'whatever', eventType: 'activated', actorId: 'a1', actorName: 'Op' });
    const useCase = new ListInternetActivationOperators(eventRepo, catalog);

    const res = await useCase.execute();
    expect(res).toEqual([]);
  });
});

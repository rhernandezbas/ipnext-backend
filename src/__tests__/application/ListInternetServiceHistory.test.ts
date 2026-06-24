/**
 * TDD — ListInternetServiceHistory (internet-history).
 *
 * GLOBAL history of INTERNET service events (mirror of ListTvActivationHistory for TV).
 *
 * CRITICAL: must return ONLY events of the INTERNET service — never TV nor any other
 * service. INTERNET is identified by ServiceCatalog.name === 'INTERNET'; the use case
 * resolves its catalog id via ServiceCatalogRepository.getByName('INTERNET') and passes
 * it as the serviceCatalogId filter to the repo.
 *
 * Uses in-memory adapters (real use case, no mocks of Prisma).
 */
import { ListInternetServiceHistory } from '@application/use-cases/ListInternetServiceHistory';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

async function setup(opts?: { now?: () => Date }) {
  const catalog = new InMemoryServiceCatalogRepository();
  const internet = await catalog.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
  const tv = await catalog.create({ name: 'TV', label: 'TV', sortOrder: 1 });
  const eventRepo = new InMemoryContractServiceEventRepository(opts);
  const useCase = new ListInternetServiceHistory(eventRepo, catalog);
  return { catalog, internet, tv, eventRepo, useCase };
}

describe('ListInternetServiceHistory — global internet history (internet-history)', () => {
  it('returns empty array when there are no events', async () => {
    const { useCase } = await setup();
    const res = await useCase.execute({});
    expect(res).toEqual([]);
  });

  it('returns ONLY internet events — excludes TV and other-service events', async () => {
    const { useCase, eventRepo, internet, tv } = await setup();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: tv.id, eventType: 'activated', actorName: 'Op' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: 'other-svc', eventType: 'activated', actorName: 'Op' });

    const res = await useCase.execute({});
    expect(res).toHaveLength(1);
    expect(res[0]!.serviceCatalogId).toBe(internet.id);
    expect(res.every(e => e.serviceCatalogId === internet.id)).toBe(true);
  });

  it('returns empty array when the INTERNET catalog entry is missing (no events leak)', async () => {
    const catalog = new InMemoryServiceCatalogRepository();
    await catalog.create({ name: 'TV', label: 'TV', sortOrder: 0 });
    const eventRepo = new InMemoryContractServiceEventRepository();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: 'whatever', eventType: 'activated', actorName: 'Op' });
    const useCase = new ListInternetServiceHistory(eventRepo, catalog);

    const res = await useCase.execute({});
    expect(res).toEqual([]);
  });

  it('orders events newest-first', async () => {
    let tick = 0;
    const times = [
      new Date('2026-07-21T09:00:00.000Z'),
      new Date('2026-07-21T10:00:00.000Z'),
    ];
    const { useCase, eventRepo, internet } = await setup({ now: () => times[tick++]! });
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'deactivated', actorName: 'Op' });

    const res = await useCase.execute({});
    expect(res).toHaveLength(2);
    expect(res[0]!.eventType).toBe('deactivated'); // newest first
    expect(res[1]!.eventType).toBe('activated');
  });

  it('filters by actorId', async () => {
    const { useCase, eventRepo, internet } = await setup();
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a1', actorName: 'Op1' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'activated', actorId: 'a2', actorName: 'Op2' });

    const res = await useCase.execute({ actorId: 'a1' });
    expect(res).toHaveLength(1);
    expect(res[0]!.actorId).toBe('a1');
  });

  it('filters by clientId (customerId alias)', async () => {
    const { useCase, eventRepo, internet } = await setup();
    eventRepo.setContractClient('ct-1', 'client-1', 'Alice');
    eventRepo.setContractClient('ct-2', 'client-2', 'Bob');
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });

    const res = await useCase.execute({ customerId: 'client-1' });
    expect(res).toHaveLength(1);
    expect(res[0]!.clientId).toBe('client-1');
    expect(res[0]!.customerName).toBe('Alice');
  });

  it('filters by from/to date range', async () => {
    let tick = 0;
    const times = [
      new Date('2026-07-20T10:00:00.000Z'),
      new Date('2026-07-22T10:00:00.000Z'),
    ];
    const { useCase, eventRepo, internet } = await setup({ now: () => times[tick++]! });
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Op' });
    await eventRepo.record({ contractId: 'ct-2', serviceCatalogId: internet.id, eventType: 'deactivated', actorName: 'Op' });

    const res = await useCase.execute({ from: new Date('2026-07-21T00:00:00.000Z') });
    expect(res).toHaveLength(1);
    expect(res[0]!.eventType).toBe('deactivated');
  });

  it('maps to the InternetServiceEventDto shape (with client + reason)', async () => {
    const { useCase, eventRepo, internet } = await setup();
    eventRepo.setContractClient('ct-1', 'client-1', 'Alice');
    await eventRepo.record({
      contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'deactivated',
      actorId: 'a1', actorName: 'Operator', reason: 'falta de pago',
    });

    const res = await useCase.execute({});
    const dto = res[0]!;
    expect(dto).toMatchObject({
      contractId: 'ct-1',
      clientId: 'client-1',
      customerName: 'Alice',
      serviceCatalogId: internet.id,
      eventType: 'deactivated',
      actorId: 'a1',
      actorName: 'Operator',
      reason: 'falta de pago',
    });
    expect(typeof dto.id).toBe('string');
    expect(typeof dto.createdAt).toBe('string');
    // No password leaks into the wire contract.
    expect((dto as unknown as Record<string, unknown>)['password']).toBeUndefined();
  });
});

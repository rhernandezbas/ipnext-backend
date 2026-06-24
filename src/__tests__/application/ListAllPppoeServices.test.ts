/**
 * TDD — ListAllPppoeServices (internet-history).
 *
 * GLOBAL paginated list of ALL PppoeService rows (the internet services page, mirror of TV),
 * each enriched with its contract→client (clientId, customerName), status, profile/plan,
 * createdAt, and WHO created it (createdBy = actorName of the 'activated' internet event of
 * that contract, when available).
 *
 * Filters: search (client or username), status, nasId. Pagination: page/limit (limit ≤ 100).
 * DTO is curated and NEVER exposes the PPPoE password.
 *
 * Uses in-memory adapters (real use case, no Prisma mocks).
 */
import { ListAllPppoeServices } from '@application/use-cases/ListAllPppoeServices';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

async function setup() {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const eventRepo = new InMemoryContractServiceEventRepository();
  const catalog = new InMemoryServiceCatalogRepository();
  const internet = await catalog.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
  const useCase = new ListAllPppoeServices(pppoeRepo, eventRepo, catalog);
  return { pppoeRepo, eventRepo, catalog, internet, useCase };
}

describe('ListAllPppoeServices — global internet services list (internet-history)', () => {
  it('returns an empty page when there are no services', async () => {
    const { useCase } = await setup();
    const res = await useCase.execute({});
    expect(res.data).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.page).toBe(1);
  });

  it('lists services with contract→client enrichment, NO password', async () => {
    const { useCase, pppoeRepo } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'juan', password: 'secret', nasId: 'nas-1', contractId: 'ct-1', remoteAddress: '10.0.0.1' });
    pppoeRepo.setContractClient('ct-1', 'client-1', 'Juan Perez');

    const res = await useCase.execute({});
    expect(res.total).toBe(1);
    const item = res.data[0]!;
    expect(item.username).toBe('juan');
    expect(item.clientId).toBe('client-1');
    expect(item.customerName).toBe('Juan Perez');
    expect(item.status).toBe('enabled');
    expect(item.nasId).toBe('nas-1');
    expect((item as unknown as Record<string, unknown>)['password']).toBeUndefined();
  });

  it('resolves createdBy from the internet activated event of the contract', async () => {
    const { useCase, pppoeRepo, eventRepo, internet } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'juan', password: 'x', nasId: 'nas-1', contractId: 'ct-1', remoteAddress: '10.0.0.1' });
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Operador Uno' });
    // a TV event on the same contract must NOT be picked as the creator
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: 'tv-id', eventType: 'activated', actorName: 'TV Guy' });

    const res = await useCase.execute({});
    expect(res.data[0]!.createdBy).toBe('Operador Uno');
  });

  it('createdBy is null when there is no internet activated event', async () => {
    const { useCase, pppoeRepo } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'juan', password: 'x', nasId: 'nas-1', contractId: 'ct-1', remoteAddress: '10.0.0.1' });

    const res = await useCase.execute({});
    expect(res.data[0]!.createdBy).toBeNull();
  });

  it('createdBy push-down: events of contracts OUTSIDE the page do not contaminate, and the query is scoped to the page contracts', async () => {
    const { useCase, pppoeRepo, eventRepo, internet } = await setup();
    // Page has exactly one service on ct-1.
    await pppoeRepo.upsertByUsername({ username: 'juan', password: 'x', nasId: 'nas-1', contractId: 'ct-1', remoteAddress: '10.0.0.1' });
    await eventRepo.record({ contractId: 'ct-1', serviceCatalogId: internet.id, eventType: 'activated', actorName: 'Operador Uno' });
    // A pile of internet events for OTHER contracts that are NOT in the page.
    for (let i = 0; i < 50; i++) {
      await eventRepo.record({ contractId: `other-${i}`, serviceCatalogId: internet.id, eventType: 'activated', actorName: `Ajeno ${i}` });
    }

    const res = await useCase.execute({ limit: 1 });
    expect(res.data[0]!.createdBy).toBe('Operador Uno');

    // The list() query must be PUSH-DOWN scoped to the page's contracts, not a full scan.
    const lastFilter = eventRepo.lastListFilter();
    expect(lastFilter).toBeDefined();
    expect(lastFilter!.contractIds).toEqual(['ct-1']);
    expect(lastFilter!.serviceCatalogId).toBe(internet.id);
  });

  it('filters by status', async () => {
    const { useCase, pppoeRepo } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'a', password: 'x', nasId: 'nas-1', status: 'enabled' });
    await pppoeRepo.upsertByUsername({ username: 'b', password: 'x', nasId: 'nas-1', status: 'disabled' });

    const res = await useCase.execute({ status: 'disabled' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.username).toBe('b');
  });

  it('filters by nasId', async () => {
    const { useCase, pppoeRepo } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'a', password: 'x', nasId: 'nas-1' });
    await pppoeRepo.upsertByUsername({ username: 'b', password: 'x', nasId: 'nas-2' });

    const res = await useCase.execute({ nasId: 'nas-2' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.username).toBe('b');
  });

  it('search matches by username', async () => {
    const { useCase, pppoeRepo } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'juan', password: 'x', nasId: 'nas-1', contractId: 'ct-1' });
    await pppoeRepo.upsertByUsername({ username: 'pedro', password: 'x', nasId: 'nas-1', contractId: 'ct-2' });

    const res = await useCase.execute({ search: 'jua' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.username).toBe('juan');
  });

  it('search matches by customer name', async () => {
    const { useCase, pppoeRepo } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'u1', password: 'x', nasId: 'nas-1', contractId: 'ct-1' });
    await pppoeRepo.upsertByUsername({ username: 'u2', password: 'x', nasId: 'nas-1', contractId: 'ct-2' });
    pppoeRepo.setContractClient('ct-1', 'client-1', 'Alice Wonderland');
    pppoeRepo.setContractClient('ct-2', 'client-2', 'Bob Builder');

    const res = await useCase.execute({ search: 'wonder' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.customerName).toBe('Alice Wonderland');
  });

  it('paginates with page/limit and reports total', async () => {
    const { useCase, pppoeRepo } = await setup();
    for (let i = 0; i < 5; i++) {
      await pppoeRepo.upsertByUsername({ username: `user${i}`, password: 'x', nasId: 'nas-1' });
    }
    const res = await useCase.execute({ page: 2, limit: 2 });
    expect(res.total).toBe(5);
    expect(res.page).toBe(2);
    expect(res.limit).toBe(2);
    expect(res.data).toHaveLength(2);
    expect(res.data[0]!.username).toBe('user2'); // username asc, page 2 of size 2
  });

  it('clamps limit to a maximum of 100', async () => {
    const { useCase } = await setup();
    const res = await useCase.execute({ limit: 500 });
    expect(res.limit).toBe(100);
  });

  it('defaults to page 1, limit 20 when omitted', async () => {
    const { useCase } = await setup();
    const res = await useCase.execute({});
    expect(res.page).toBe(1);
    expect(res.limit).toBe(20);
  });

  it('the repo list projection does NOT carry the password (defense in depth)', async () => {
    const { pppoeRepo } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'juan', password: 'SUPER-SECRET', nasId: 'nas-1', contractId: 'ct-1' });

    const { data } = await pppoeRepo.listAllPaginated({ page: 1, pageSize: 10 });
    expect(data).toHaveLength(1);
    expect((data[0] as unknown as Record<string, unknown>)['password']).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('SUPER-SECRET');
  });
});

import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { ListContracts } from '@application/use-cases/ListContracts';

describe('ListContracts use case', () => {
  let repo: InMemoryContractRepository;
  let listContracts: ListContracts;

  beforeEach(() => {
    repo = new InMemoryContractRepository();
    listContracts = new ListContracts(repo);
  });

  it('returns an empty page envelope when there are no services', async () => {
    const res = await listContracts.execute({ page: 1, limit: 25 });
    expect(res).toEqual({ data: [], total: 0, page: 1, pageSize: 25, totalPages: 1 });
  });

  it('returns ContractSummary-shaped items with the FE envelope', async () => {
    repo.seed({ clientId: 'client-42', clientName: 'Acme Corp', plan: 'Fiber 100', status: 'active', technology: 'Fiber', startDate: '2024-01-10T00:00:00.000Z' });
    const res = await listContracts.execute({ page: 1, limit: 25 });
    expect(res.total).toBe(1);
    expect(res.data[0]).toEqual({
      id: expect.any(String),
      clientId: 'client-42',
      code: null,
      clientName: 'Acme Corp',
      plan: 'Fiber 100',
      status: 'active',
      technology: 'Fiber',
      startDate: '2024-01-10T00:00:00.000Z',
      networkSiteId: null,
      networkSiteName: null,
      accessPointId: null,
      accessPointName: null,
    });
    // Envelope keys match the frontend PaginatedResponse exactly.
    expect(Object.keys(res).sort()).toEqual(['data', 'page', 'pageSize', 'total', 'totalPages']);
  });

  it('exposes clientId so the contracts page can deep-link to the customer (#56)', async () => {
    repo.seed({ clientId: 'abc-123', clientName: 'Juan Pérez', plan: 'P1' });
    const res = await listContracts.execute({ page: 1, limit: 25 });
    expect(res.data[0]!.clientId).toBe('abc-123');
  });

  it('preserves null technology', async () => {
    repo.seed({ clientName: 'No Tech', plan: 'Basic', technology: null });
    const res = await listContracts.execute({ page: 1, limit: 25 });
    expect(res.data[0]!.technology).toBeNull();
  });

  it('filters by status (exact match)', async () => {
    repo.seed({ clientName: 'A', plan: 'P1', status: 'active' });
    repo.seed({ clientName: 'B', plan: 'P2', status: 'blocked' });
    const res = await listContracts.execute({ page: 1, limit: 25, status: 'blocked' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.status).toBe('blocked');
  });

  it('filters by technology (exact match)', async () => {
    repo.seed({ clientName: 'A', plan: 'P1', technology: 'Fiber' });
    repo.seed({ clientName: 'B', plan: 'P2', technology: 'Wireless' });
    const res = await listContracts.execute({ page: 1, limit: 25, technology: 'Wireless' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.technology).toBe('Wireless');
  });

  it('search matches plan (case-insensitive)', async () => {
    repo.seed({ clientName: 'A', plan: 'Fiber 100' });
    repo.seed({ clientName: 'B', plan: 'Wireless 50' });
    const res = await listContracts.execute({ page: 1, limit: 25, search: 'fiber' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.plan).toBe('Fiber 100');
  });

  it('search matches client name (case-insensitive)', async () => {
    repo.seed({ clientName: 'Juan Pérez', plan: 'P1' });
    repo.seed({ clientName: 'Other', plan: 'P2' });
    const res = await listContracts.execute({ page: 1, limit: 25, search: 'juan' });
    expect(res.total).toBe(1);
    expect(res.data[0]!.clientName).toBe('Juan Pérez');
  });

  it('paginates and computes totalPages', async () => {
    for (let i = 0; i < 5; i++) repo.seed({ clientName: `C${i}`, plan: `P${i}` });
    const res = await listContracts.execute({ page: 2, limit: 2 });
    expect(res.total).toBe(5);
    expect(res.page).toBe(2);
    expect(res.pageSize).toBe(2);
    expect(res.totalPages).toBe(3);
    expect(res.data).toHaveLength(2);
  });

  it('defaults page to 1 and limit to 25 when omitted', async () => {
    repo.seed({ clientName: 'A', plan: 'P1' });
    const res = await listContracts.execute({});
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(25);
  });
});

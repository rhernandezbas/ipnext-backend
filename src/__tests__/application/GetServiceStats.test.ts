import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { GetContractStats } from '@application/use-cases/GetContractStats';

describe('GetContractStats use case', () => {
  let repo: InMemoryContractRepository;
  let getContractStats: GetContractStats;

  beforeEach(() => {
    repo = new InMemoryContractRepository();
    getContractStats = new GetContractStats(repo);
  });

  it('returns total 0 and empty byStatus when there are no services', async () => {
    const result = await getContractStats.execute();
    expect(result).toEqual({ total: 0, byStatus: {} });
  });

  it('counts a single status correctly', async () => {
    repo.seed({ clientName: 'A', plan: 'P1', status: 'Vigente' });
    repo.seed({ clientName: 'B', plan: 'P2', status: 'Vigente' });
    const result = await getContractStats.execute();
    expect(result.total).toBe(2);
    expect(result.byStatus).toEqual({ Vigente: 2 });
  });

  it('aggregates multiple statuses dynamically', async () => {
    repo.seed({ clientName: 'A', plan: 'P1', status: 'Vigente' });
    repo.seed({ clientName: 'B', plan: 'P2', status: 'Vigente' });
    repo.seed({ clientName: 'C', plan: 'P3', status: 'Baja' });
    repo.seed({ clientName: 'D', plan: 'P4', status: 'Suspendido' });
    const result = await getContractStats.execute();
    expect(result.total).toBe(4);
    expect(result.byStatus).toEqual({ Vigente: 2, Baja: 1, Suspendido: 1 });
  });

  it('handles arbitrary unknown status values without hardcoding', async () => {
    repo.seed({ clientName: 'X', plan: 'P', status: 'Nuevo Estado Raro' });
    const result = await getContractStats.execute();
    expect(result.total).toBe(1);
    expect(result.byStatus['Nuevo Estado Raro']).toBe(1);
  });

  it('returns correct shape { total: number; byStatus: Record<string, number> }', async () => {
    repo.seed({ clientName: 'A', plan: 'P', status: 'Vigente' });
    const result = await getContractStats.execute();
    expect(typeof result.total).toBe('number');
    expect(typeof result.byStatus).toBe('object');
    expect(typeof result.byStatus['Vigente']).toBe('number');
  });
});

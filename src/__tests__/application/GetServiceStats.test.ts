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

  it('canonicalizes raw GR status into the FE enum before bucketing', async () => {
    repo.seed({ clientName: 'A', plan: 'P1', status: 'Vigente' });
    repo.seed({ clientName: 'B', plan: 'P2', status: 'Vigente' });
    const result = await getContractStats.execute();
    expect(result.total).toBe(2);
    // 'Vigente' → 'active', never bucketed under the raw text.
    expect(result.byStatus).toEqual({ active: 2 });
  });

  it('aggregates multiple statuses dynamically (all canonical)', async () => {
    repo.seed({ clientName: 'A', plan: 'P1', status: 'Vigente' });
    repo.seed({ clientName: 'B', plan: 'P2', status: 'Vigente' });
    repo.seed({ clientName: 'C', plan: 'P3', status: 'Baja' });
    repo.seed({ clientName: 'D', plan: 'P4', status: 'Suspendido' });
    const result = await getContractStats.execute();
    expect(result.total).toBe(4);
    expect(result.byStatus).toEqual({ active: 2, baja: 1, blocked: 1 });
  });

  it('COLLAPSES legacy raw + new canonical into the same bucket (S1 — deploy window safety)', async () => {
    // Mixed DB: a legacy row stored raw 'Vigente' and a new row stored canonical 'active'
    // must sum together in 'active', not split into separate buckets.
    repo.seed({ clientName: 'legacy', plan: 'P1', status: 'Vigente' });
    repo.seed({ clientName: 'new', plan: 'P2', status: 'active' });
    const result = await getContractStats.execute();
    expect(result.total).toBe(2);
    expect(result.byStatus).toEqual({ active: 2 });
  });

  it('maps an unknown status value to the fail-closed default (inactive)', async () => {
    repo.seed({ clientName: 'X', plan: 'P', status: 'Nuevo Estado Raro' });
    const result = await getContractStats.execute();
    expect(result.total).toBe(1);
    // Unknown → 'inactive' (fail-closed), never the raw text.
    expect(result.byStatus).toEqual({ inactive: 1 });
  });

  it('returns correct shape { total: number; byStatus: Record<string, number> }', async () => {
    repo.seed({ clientName: 'A', plan: 'P', status: 'Vigente' });
    const result = await getContractStats.execute();
    expect(typeof result.total).toBe('number');
    expect(typeof result.byStatus).toBe('object');
    expect(typeof result.byStatus['active']).toBe('number');
  });
});

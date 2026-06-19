import { ListPlans } from '@application/use-cases/ListPlans';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';

describe('ListPlans', () => {
  it('returns empty list when no plans', async () => {
    const repo = new InMemoryPlanRepository();
    const uc = new ListPlans(repo);
    expect(await uc.execute()).toEqual([]);
  });

  it('returns all plans', async () => {
    const repo = new InMemoryPlanRepository();
    await repo.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'Air', downloadKbps: 30000, uploadKbps: 10000 });
    const uc = new ListPlans(repo);
    const result = await uc.execute();
    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('IP-Air-30-10');
  });
});

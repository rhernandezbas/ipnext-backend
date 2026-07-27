import { GetFinancePlanPrices } from '@application/use-cases/finance/GetFinancePlanPrices';
import { InMemoryFinancePlanPriceRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePlanPriceRepository';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';

describe('GetFinancePlanPrices (task 2.15)', () => {
  it('LEFT JOIN: a plan with no configured price appears with estimatedMonthlyPrice: 0, never omitted', async () => {
    const plans = new InMemoryPlanRepository();
    await plans.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'wireless', downloadKbps: 30000, uploadKbps: 10000 });
    await plans.upsertByCode({ code: 'IP-Fibra-100-50', name: 'Fibra 100/50', category: 'fibra', downloadKbps: 100000, uploadKbps: 50000 });
    const prices = new InMemoryFinancePlanPriceRepository();
    await prices.upsert('IP-Fibra-100-50', { estimatedMonthlyPrice: 12000, updatedByUserId: 'u1' });

    const useCase = new GetFinancePlanPrices(prices, plans);
    const result = await useCase.execute();

    expect(result).toHaveLength(2);
    const fibra = result.find((r) => r.planCode === 'IP-Fibra-100-50');
    const air = result.find((r) => r.planCode === 'IP-Air-30-10');
    expect(fibra).toMatchObject({ planCode: 'IP-Fibra-100-50', planName: 'Fibra 100/50', estimatedMonthlyPrice: 12000 });
    expect(air).toMatchObject({ planCode: 'IP-Air-30-10', planName: 'Air 30/10', estimatedMonthlyPrice: 0 });
    expect(air?.updatedAt).toBeNull();
  });

  // ── fix-wave-1 LOW E — `PlanRepository.list()` explicitly does NOT
  // guarantee order (Prisma: DB heap order, which reshuffles after an
  // UPDATE; in-memory: insertion order — see the port's docblock). Unlike
  // `GetFinanceTechnologyCosts` (whose `ContractTechnologyRepository.list()`
  // already returns `orderBy: name asc`), this use case must sort itself —
  // `ListPlans` does; this one didn't. Inserted here in "Fibra" (F) then
  // "Air" (A) order — insertion order alone would return them unsorted.
  it('E: sorts the result by planCode (the port does not guarantee order)', async () => {
    const plans = new InMemoryPlanRepository();
    await plans.upsertByCode({ code: 'IP-Fibra-100-50', name: 'Fibra 100/50', category: 'fibra', downloadKbps: 100000, uploadKbps: 50000 });
    await plans.upsertByCode({ code: 'IP-Air-30-10', name: 'Air 30/10', category: 'wireless', downloadKbps: 30000, uploadKbps: 10000 });
    const prices = new InMemoryFinancePlanPriceRepository();

    const useCase = new GetFinancePlanPrices(prices, plans);
    const result = await useCase.execute();

    expect(result.map((r) => r.planCode)).toEqual(['IP-Air-30-10', 'IP-Fibra-100-50']);
  });
});

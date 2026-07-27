import { UpdateFinancePlanPrice } from '@application/use-cases/finance/UpdateFinancePlanPrice';
import { InMemoryFinancePlanPriceRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePlanPriceRepository';
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';
import { FinancePlanNotFoundError, FinanceValidationError } from '@domain/errors/finance';

/** Seeds the Plan catalog with `codes` (fix-wave-1 D: existence guard). */
async function catalogWith(...codes: string[]): Promise<InMemoryPlanRepository> {
  const plans = new InMemoryPlanRepository();
  for (const code of codes) {
    await plans.upsertByCode({ code, name: `Plan ${code}`, category: 'fibra', downloadKbps: 100000, uploadKbps: 50000 });
  }
  return plans;
}

describe('UpdateFinancePlanPrice (tasks 2.17-2.18)', () => {
  it('2.17: rejects a negative value without persisting', async () => {
    const repo = new InMemoryFinancePlanPriceRepository();
    repo.seed({ planCode: 'IP-Fibra-100-50', estimatedMonthlyPrice: 12000, updatedByUserId: 'old', updatedAt: new Date('2026-01-01') });
    const useCase = new UpdateFinancePlanPrice(repo, await catalogWith('IP-Fibra-100-50'));

    await expect(useCase.execute('IP-Fibra-100-50', { estimatedMonthlyPrice: -1 }, 'actor-1')).rejects.toBeInstanceOf(FinanceValidationError);

    expect(await repo.getByPlanCode('IP-Fibra-100-50')).toMatchObject({ estimatedMonthlyPrice: 12000, updatedByUserId: 'old' });
  });

  it('a valid payload upserts, updatedByUserId from the actor', async () => {
    const repo = new InMemoryFinancePlanPriceRepository();
    const useCase = new UpdateFinancePlanPrice(repo, await catalogWith('IP-Air-30-10'));

    const result = await useCase.execute('IP-Air-30-10', { estimatedMonthlyPrice: 8000 }, 'actor-9');

    expect(result).toMatchObject({ planCode: 'IP-Air-30-10', estimatedMonthlyPrice: 8000, updatedByUserId: 'actor-9' });
  });

  // ── fix-wave-1 LOW F — the PUT response omitted `planName` while the GET
  // row (`FinancePlanPriceView`) carries it; a FE that patches its local row
  // with the PUT response left `planName` `undefined` until the next GET.
  // The use case already fetches the catalog `plan` for the D existence
  // guard, so surfacing `plan.name` here costs nothing extra.
  it('F: the result carries planName from the catalog (no second lookup needed downstream)', async () => {
    const repo = new InMemoryFinancePlanPriceRepository();
    const useCase = new UpdateFinancePlanPrice(repo, await catalogWith('IP-Fibra-100-50'));

    const result = await useCase.execute('IP-Fibra-100-50', { estimatedMonthlyPrice: 12000 }, 'actor-1');

    expect(result.planName).toBe('Plan IP-Fibra-100-50');
  });

  // ── fix-wave-1 D — a typo'd/retired planCode upserted a silent orphan
  // (GetFinancePlanPrices' catalog-driven LEFT JOIN never surfaces it).
  it('D: rejects a planCode absent from the Plan catalog with 404, no persist', async () => {
    const repo = new InMemoryFinancePlanPriceRepository();
    const useCase = new UpdateFinancePlanPrice(repo, await catalogWith('IP-Fibra-100-50'));

    await expect(useCase.execute('IP-Nope-404', { estimatedMonthlyPrice: 8000 }, 'actor-1')).rejects.toBeInstanceOf(FinancePlanNotFoundError);
    expect(await repo.getByPlanCode('IP-Nope-404')).toBeNull();
  });

  // ── fix-wave-1 A — Decimal(12,2) can't hold 1e12; must 400, never reach the repo.
  it('A: rejects estimatedMonthlyPrice beyond Decimal(12,2) magnitude, no persist', async () => {
    const repo = new InMemoryFinancePlanPriceRepository();
    const useCase = new UpdateFinancePlanPrice(repo, await catalogWith('IP-Fibra-100-50'));

    await expect(useCase.execute('IP-Fibra-100-50', { estimatedMonthlyPrice: 1e12 }, 'actor-1')).rejects.toBeInstanceOf(FinanceValidationError);
    expect(await repo.getByPlanCode('IP-Fibra-100-50')).toBeNull();
  });
});

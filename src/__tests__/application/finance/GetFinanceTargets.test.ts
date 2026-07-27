import { GetFinanceTargets } from '@application/use-cases/finance/GetFinanceTargets';
import { InMemoryFinanceTargetsConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceTargetsConfigRepository';

describe('GetFinanceTargets (task 2.21)', () => {
  it('returns the seeded defaults when it was never edited', async () => {
    const useCase = new GetFinanceTargets(new InMemoryFinanceTargetsConfigRepository());

    const result = await useCase.execute();

    expect(result).toEqual({
      churnTargetPct: 5,
      maxPaybackMonths: 12,
      monthlyNewContractsGoal: 0,
      inflationBaseYearMonth: '',
    });
  });

  it('returns the persisted row once edited', async () => {
    const repo = new InMemoryFinanceTargetsConfigRepository();
    await repo.update({ churnTargetPct: 3, maxPaybackMonths: 10, monthlyNewContractsGoal: 50, inflationBaseYearMonth: '2026-01' });
    const useCase = new GetFinanceTargets(repo);

    expect(await useCase.execute()).toEqual({
      churnTargetPct: 3,
      maxPaybackMonths: 10,
      monthlyNewContractsGoal: 50,
      inflationBaseYearMonth: '2026-01',
    });
  });
});

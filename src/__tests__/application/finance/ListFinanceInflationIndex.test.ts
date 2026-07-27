import { ListFinanceInflationIndex } from '@application/use-cases/finance/ListFinanceInflationIndex';
import { InMemoryFinanceInflationIndexRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInflationIndexRepository';

describe('ListFinanceInflationIndex (task 2.28)', () => {
  it('filters by from/to range, ordered ascending by yearMonth', async () => {
    const repo = new InMemoryFinanceInflationIndexRepository();
    // Seeded out of order on purpose.
    repo.seed({ yearMonth: '2026-03', monthlyRatePct: 3.1, source: 'INDEC', createdAt: new Date(), updatedAt: new Date() });
    repo.seed({ yearMonth: '2026-01', monthlyRatePct: 4.2, source: 'INDEC', createdAt: new Date(), updatedAt: new Date() });
    repo.seed({ yearMonth: '2026-05', monthlyRatePct: 2.5, source: 'INDEC', createdAt: new Date(), updatedAt: new Date() });
    repo.seed({ yearMonth: '2026-02', monthlyRatePct: 3.8, source: 'INDEC', createdAt: new Date(), updatedAt: new Date() });

    const useCase = new ListFinanceInflationIndex(repo);
    const result = await useCase.execute('2026-01', '2026-03');

    expect(result.map((r) => r.yearMonth)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('no range → returns the whole series ascending', async () => {
    const repo = new InMemoryFinanceInflationIndexRepository();
    repo.seed({ yearMonth: '2026-02', monthlyRatePct: 1, source: null, createdAt: new Date(), updatedAt: new Date() });
    repo.seed({ yearMonth: '2026-01', monthlyRatePct: 1, source: null, createdAt: new Date(), updatedAt: new Date() });

    const useCase = new ListFinanceInflationIndex(repo);
    expect((await useCase.execute()).map((r) => r.yearMonth)).toEqual(['2026-01', '2026-02']);
  });
});

import { GetFinanceCohorts } from '@application/use-cases/finance/GetFinanceCohorts';
import { InMemoryFinanceCohortSnapshotRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceCohortSnapshotRepository';

describe('GetFinanceCohorts (design.md HTTP Contract "GET /cohorts")', () => {
  it('computes 3-month survival correctly from a persisted cohort row', async () => {
    const repo = new InMemoryFinanceCohortSnapshotRepository();
    await repo.upsert('2026-01', 3, { originalCount: 20, survivingCount: 18 });

    const result = await new GetFinanceCohorts(repo).execute('2026-01', '2026-01');

    expect(result.cohorts).toHaveLength(1);
    expect(result.cohorts[0]).toEqual({
      cohortYearMonth: '2026-01',
      originalCount: 20,
      survival: { m3: { survivingCount: 18, pct: 90 }, m6: null, m12: null },
    });
  });

  it('a cohort younger than 12 months has no m12 data point (null, never 0 or 100)', async () => {
    const repo = new InMemoryFinanceCohortSnapshotRepository();
    // Only 3 and 6 have run — the cohort is only 5 months old, no m12 possible yet.
    await repo.upsert('2026-02', 3, { originalCount: 10, survivingCount: 9 });

    const result = await new GetFinanceCohorts(repo).execute('2026-02', '2026-02');

    expect(result.cohorts[0].survival.m12).toBeNull();
  });

  it('a cohort month absent from the range (job never ran) is OMITTED entirely, not a zero row', async () => {
    const repo = new InMemoryFinanceCohortSnapshotRepository();
    await repo.upsert('2026-01', 3, { originalCount: 10, survivingCount: 10 });
    // 2026-02 never computed.

    const result = await new GetFinanceCohorts(repo).execute('2026-01', '2026-02');

    expect(result.cohorts.map((c) => c.cohortYearMonth)).toEqual(['2026-01']);
  });

  it('fix-wave-4 🟡9 — a cohort month with NO row at all is ALSO surfaced in monthsWithoutCohortSnapshot, the /overview pattern for "no computado" vs "no hubo altas" (measured prod state: the backfill never ran)', async () => {
    const repo = new InMemoryFinanceCohortSnapshotRepository();
    await repo.upsert('2026-01', 3, { originalCount: 10, survivingCount: 10 });
    // 2026-02/2026-03 never computed at all — the measured prod state today.

    const result = await new GetFinanceCohorts(repo).execute('2026-01', '2026-03');

    expect(result.cohorts.map((c) => c.cohortYearMonth)).toEqual(['2026-01']);
    expect(result.monthsWithoutCohortSnapshot).toEqual(['2026-02', '2026-03']);
  });

  it('an entirely empty range (nothing ever computed) surfaces EVERY month in monthsWithoutCohortSnapshot, the honest equivalent of /overview\'s bare [] response', async () => {
    const repo = new InMemoryFinanceCohortSnapshotRepository();

    const result = await new GetFinanceCohorts(repo).execute('2026-01', '2026-02');

    expect(result.cohorts).toEqual([]);
    expect(result.monthsWithoutCohortSnapshot).toEqual(['2026-01', '2026-02']);
  });

  it('rejects malformed range params without querying', async () => {
    const repo = new InMemoryFinanceCohortSnapshotRepository();
    const useCase = new GetFinanceCohorts(repo);
    await expect(useCase.execute('2026-1', '2026-02')).rejects.toThrow();
    await expect(useCase.execute('2026-03', '2026-01')).rejects.toThrow();
  });

  it('fix-wave-4 🔵17 — rejects a range wider than 240 months', async () => {
    const repo = new InMemoryFinanceCohortSnapshotRepository();
    const useCase = new GetFinanceCohorts(repo);
    await expect(useCase.execute('1990-01', '2026-12')).rejects.toThrow();
  });
});

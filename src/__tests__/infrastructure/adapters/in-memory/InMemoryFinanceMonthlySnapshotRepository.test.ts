import { InMemoryFinanceMonthlySnapshotRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceMonthlySnapshotRepository';
import { InMemoryFinanceCohortSnapshotRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceCohortSnapshotRepository';

function row(overrides: Partial<Parameters<InMemoryFinanceMonthlySnapshotRepository['upsert']>[1]> = {}) {
  return {
    contractsActive: 1,
    contractsNew: 0,
    contractsChurned: 0,
    contractsUpgraded: 0,
    contractsDowngraded: 0,
    mrrInicialArs: 0,
    mrrNewArs: 0,
    mrrUpgradeArs: 0,
    mrrDowngradeArs: 0,
    mrrChurnArs: 0,
    mrrFinalArs: 0,
    bridgeResidualArs: 0,
    unpricedContractsActive: 0,
    unpricedContractsPct: 0,
    unpricedPlanChangeEvents: 0,
    enforcementPlanChangeEventsExcluded: 0,
    revenueTotalArs: 0,
    collectionRatePct: null,
    revenueAttributableArs: 0,
    unclassifiedAmountArs: 0,
    attributionPct: 0,
    arpuArs: 0,
    churnContractsPct: 0,
    churnRevenuePct: null,
    ...overrides,
  };
}

describe('InMemoryFinanceMonthlySnapshotRepository', () => {
  it('get() returns null when no row exists', async () => {
    const repo = new InMemoryFinanceMonthlySnapshotRepository();
    expect(await repo.get('2026-01')).toBeNull();
  });

  it('upsert() is idempotent and overwrites the whole row', async () => {
    const repo = new InMemoryFinanceMonthlySnapshotRepository();
    await repo.upsert('2026-01', row({ mrrFinalArs: 1000 }));
    await repo.upsert('2026-01', row({ mrrFinalArs: 2000 }));
    const got = await repo.get('2026-01');
    expect(got?.mrrFinalArs).toBe(2000);
  });

  it('listRange() returns rows within the inclusive range, sorted ascending', async () => {
    const repo = new InMemoryFinanceMonthlySnapshotRepository();
    await repo.upsert('2026-03', row());
    await repo.upsert('2026-01', row());
    await repo.upsert('2026-02', row());
    await repo.upsert('2025-12', row());
    const result = await repo.listRange('2026-01', '2026-03');
    expect(result.map((r) => r.yearMonth)).toEqual(['2026-01', '2026-02', '2026-03']);
  });
});

describe('InMemoryFinanceCohortSnapshotRepository', () => {
  it('listByCohort() returns rows sorted by monthsElapsed ascending', async () => {
    const repo = new InMemoryFinanceCohortSnapshotRepository();
    await repo.upsert('2026-01', 12, { originalCount: 10, survivingCount: 5 });
    await repo.upsert('2026-01', 3, { originalCount: 10, survivingCount: 9 });
    await repo.upsert('2026-01', 6, { originalCount: 10, survivingCount: 7 });
    const rows = await repo.listByCohort('2026-01');
    expect(rows.map((r) => r.monthsElapsed)).toEqual([3, 6, 12]);
  });

  it('upsert() is idempotent per (cohortYearMonth, monthsElapsed)', async () => {
    const repo = new InMemoryFinanceCohortSnapshotRepository();
    await repo.upsert('2026-01', 3, { originalCount: 10, survivingCount: 9 });
    await repo.upsert('2026-01', 3, { originalCount: 10, survivingCount: 8 });
    const rows = await repo.listByCohort('2026-01');
    expect(rows).toHaveLength(1);
    expect(rows[0].survivingCount).toBe(8);
  });

  it('different cohort months are isolated from each other', async () => {
    const repo = new InMemoryFinanceCohortSnapshotRepository();
    await repo.upsert('2026-01', 3, { originalCount: 10, survivingCount: 9 });
    await repo.upsert('2026-02', 3, { originalCount: 20, survivingCount: 18 });
    expect(await repo.listByCohort('2026-01')).toHaveLength(1);
    expect(await repo.listByCohort('2026-02')).toHaveLength(1);
  });
});

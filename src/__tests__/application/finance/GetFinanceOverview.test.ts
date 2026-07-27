import { GetFinanceOverview } from '@application/use-cases/finance/GetFinanceOverview';
import { InMemoryFinanceMonthlySnapshotRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceMonthlySnapshotRepository';
import { InMemoryFinanceInflationIndexRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInflationIndexRepository';
import { InMemoryFinanceTargetsConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceTargetsConfigRepository';
import type { FinanceMonthlySnapshot } from '@domain/ports/FinanceMonthlySnapshotRepository';

/** Minimal, realistic snapshot fixture — every field distinct so a swapped-field bug would show up as a shape mismatch, not a coincidental pass. */
function makeSnapshot(yearMonth: string, overrides: Partial<FinanceMonthlySnapshot> = {}): Omit<FinanceMonthlySnapshot, 'computedAt'> {
  return {
    yearMonth,
    contractsActive: 100,
    contractsNew: 5,
    contractsChurned: 2,
    contractsUpgraded: 1,
    contractsDowngraded: 0,
    mrrInicialArs: 100000,
    mrrNewArs: 5000,
    mrrUpgradeArs: 1000,
    mrrDowngradeArs: 0,
    mrrChurnArs: 2000,
    mrrFinalArs: 104000,
    bridgeResidualArs: 0,
    unpricedContractsActive: 0,
    unpricedContractsPct: 0,
    unpricedPlanChangeEvents: 0,
    enforcementPlanChangeEventsExcluded: 0,
    revenueTotalArs: 98000,
    collectionRatePct: 94.23,
    revenueAttributableArs: 90000,
    unclassifiedAmountArs: 0,
    attributionPct: 91.83,
    arpuArs: 940,
    churnContractsPct: 2,
    churnRevenuePct: 2,
    ...overrides,
  };
}

async function seedSnapshots(repo: InMemoryFinanceMonthlySnapshotRepository, rows: Array<Omit<FinanceMonthlySnapshot, 'computedAt'>>) {
  for (const row of rows) {
    const { yearMonth, ...rest } = row;
    await repo.upsert(yearMonth, rest);
  }
}

describe('GetFinanceOverview (design.md HTTP Contract "GET /overview", Decision 3)', () => {
  it('4.1 — a fully-loaded IPC range chains multiplicatively and produces a real series for every month', async () => {
    const snapshotRepo = new InMemoryFinanceMonthlySnapshotRepository();
    await seedSnapshots(snapshotRepo, [
      makeSnapshot('2026-01', { mrrFinalArs: 100000, revenueTotalArs: 100000 }),
      makeSnapshot('2026-02', { mrrFinalArs: 100000, revenueTotalArs: 100000 }),
      makeSnapshot('2026-03', { mrrFinalArs: 100000, revenueTotalArs: 100000 }),
    ]);
    const inflationRepo = new InMemoryFinanceInflationIndexRepository();
    inflationRepo.seed({ yearMonth: '2026-02', monthlyRatePct: 4, source: null, createdAt: new Date(), updatedAt: new Date() });
    inflationRepo.seed({ yearMonth: '2026-03', monthlyRatePct: 3, source: null, createdAt: new Date(), updatedAt: new Date() });
    const targetsRepo = new InMemoryFinanceTargetsConfigRepository();
    targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '2026-01' });

    const result = await new GetFinanceOverview(snapshotRepo, inflationRepo, targetsRepo).execute('2026-01', '2026-03');

    expect(result.realSeriesMissingMonths).toEqual([]);
    expect(result.monthsWithoutSnapshot).toEqual([]);
    const [jan, feb, mar] = result.months;
    expect(jan.mrrFinalRealArs).toBeCloseTo(100000, 6); // base month — real === nominal
    expect(feb.mrrFinalRealArs).toBeCloseTo(100000 / 1.04, 2);
    expect(mar.mrrFinalRealArs).toBeCloseTo(100000 / (1.04 * 1.03), 2); // multiplicative chain, not additive
  });

  it('fix-wave-4 🔴1 — realSeriesMissingMonths lists EVERY null month, not just the first one, matching a non-contiguous gap in BOTH directions (review-measured scenario)', async () => {
    const snapshotRepo = new InMemoryFinanceMonthlySnapshotRepository();
    await seedSnapshots(snapshotRepo, [
      makeSnapshot('2026-01', { mrrFinalArs: 100000 }),
      makeSnapshot('2026-02', { mrrFinalArs: 100000 }),
      makeSnapshot('2026-03', { mrrFinalArs: 100000 }),
      makeSnapshot('2026-04', { mrrFinalArs: 100000 }),
      makeSnapshot('2026-05', { mrrFinalArs: 100000 }),
      makeSnapshot('2026-06', { mrrFinalArs: 100000 }),
    ]);
    const inflationRepo = new InMemoryFinanceInflationIndexRepository();
    // Rates loaded ONLY at 2026-03 (bridges Feb->Mar) and 2026-04 (bridges Mar->Apr).
    inflationRepo.seed({ yearMonth: '2026-03', monthlyRatePct: 10, source: null, createdAt: new Date(), updatedAt: new Date() });
    inflationRepo.seed({ yearMonth: '2026-04', monthlyRatePct: 10, source: null, createdAt: new Date(), updatedAt: new Date() });
    const targetsRepo = new InMemoryFinanceTargetsConfigRepository();
    targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '2026-03' });

    const result = await new GetFinanceOverview(snapshotRepo, inflationRepo, targetsRepo).execute('2026-01', '2026-06');

    // The honest, exhaustive list — 02/03/04 have REAL values (not missing),
    // 01/05/06 do not. A single `truncatedAt` marker could never express this.
    expect(result.realSeriesMissingMonths).toEqual(['2026-01', '2026-05', '2026-06']);
    const byMonth = new Map(result.months.map((m) => [m.yearMonth, m]));
    expect(byMonth.get('2026-01')!.mrrFinalRealArs).toBeNull();
    expect(byMonth.get('2026-02')!.mrrFinalRealArs).not.toBeNull();
    expect(byMonth.get('2026-03')!.mrrFinalRealArs).not.toBeNull();
    expect(byMonth.get('2026-04')!.mrrFinalRealArs).not.toBeNull();
    expect(byMonth.get('2026-05')!.mrrFinalRealArs).toBeNull();
    expect(byMonth.get('2026-06')!.mrrFinalRealArs).toBeNull();
  });

  it('fix-wave-4 🟡13 — a gap chronologically BEFORE "from" (needed only to bridge base to the visible window) never leaks into realSeriesMissingMonths as an out-of-range month', async () => {
    const snapshotRepo = new InMemoryFinanceMonthlySnapshotRepository();
    await seedSnapshots(snapshotRepo, [makeSnapshot('2025-01', { mrrFinalArs: 100000 }), makeSnapshot('2025-02', { mrrFinalArs: 100000 })]);
    const inflationRepo = new InMemoryFinanceInflationIndexRepository();
    // base = 2024-01 is far before the requested range; the rate bridging
    // 2024-03->2024-04 is deliberately missing, breaking the forward chain
    // long before it ever reaches 2025-01 — but 2024-04 itself must NEVER
    // appear in the response since the caller never asked about it.
    inflationRepo.seed({ yearMonth: '2024-02', monthlyRatePct: 1, source: null, createdAt: new Date(), updatedAt: new Date() });
    inflationRepo.seed({ yearMonth: '2024-03', monthlyRatePct: 1, source: null, createdAt: new Date(), updatedAt: new Date() });
    // 2024-04 rate missing on purpose — breaks the chain before "from".
    const targetsRepo = new InMemoryFinanceTargetsConfigRepository();
    targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '2024-01' });

    const result = await new GetFinanceOverview(snapshotRepo, inflationRepo, targetsRepo).execute('2025-01', '2025-02');

    expect(result.realSeriesMissingMonths).toEqual(['2025-01', '2025-02']);
    expect(result.realSeriesMissingMonths).not.toContain('2024-04');
  });

  it('4.2 — a month missing IPC inside the range truncates the real series there, nominal stays complete', async () => {
    const snapshotRepo = new InMemoryFinanceMonthlySnapshotRepository();
    await seedSnapshots(snapshotRepo, [
      makeSnapshot('2026-01', { mrrFinalArs: 100000 }),
      makeSnapshot('2026-02', { mrrFinalArs: 110000 }),
      makeSnapshot('2026-03', { mrrFinalArs: 120000 }), // this month has NO IPC row
      makeSnapshot('2026-04', { mrrFinalArs: 130000 }),
    ]);
    const inflationRepo = new InMemoryFinanceInflationIndexRepository();
    inflationRepo.seed({ yearMonth: '2026-02', monthlyRatePct: 5, source: null, createdAt: new Date(), updatedAt: new Date() });
    // 2026-03's rate is deliberately absent.
    inflationRepo.seed({ yearMonth: '2026-04', monthlyRatePct: 5, source: null, createdAt: new Date(), updatedAt: new Date() });
    const targetsRepo = new InMemoryFinanceTargetsConfigRepository();
    targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '2026-01' });

    const result = await new GetFinanceOverview(snapshotRepo, inflationRepo, targetsRepo).execute('2026-01', '2026-04');

    expect(result.realSeriesMissingMonths).toEqual(['2026-03', '2026-04']);
    // Nominal series stays complete for ALL 4 months regardless of the IPC gap.
    expect(result.months.map((m) => m.mrrFinalArs)).toEqual([100000, 110000, 120000, 130000]);
    expect(result.months.map((m) => m.yearMonth)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    // Real series: Jan/Feb reachable, Mar/Apr (>= the gap) are null — NEVER 0, NEVER interpolated.
    expect(result.months[0].mrrFinalRealArs).not.toBeNull();
    expect(result.months[1].mrrFinalRealArs).not.toBeNull();
    expect(result.months[2].mrrFinalRealArs).toBeNull();
    expect(result.months[3].mrrFinalRealArs).toBeNull();
    expect(result.months[2].revenueTotalRealArs).toBeNull();
  });

  it('4.3 — inflationBaseYearMonth unset ("") makes the ENTIRE real series null, realSeriesMissingMonths = every month of the range', async () => {
    const snapshotRepo = new InMemoryFinanceMonthlySnapshotRepository();
    await seedSnapshots(snapshotRepo, [makeSnapshot('2026-01'), makeSnapshot('2026-02')]);
    const inflationRepo = new InMemoryFinanceInflationIndexRepository();
    const targetsRepo = new InMemoryFinanceTargetsConfigRepository();
    // Never seeded — repo.get() returns the seeded-table default inflationBaseYearMonth: ''.

    const result = await new GetFinanceOverview(snapshotRepo, inflationRepo, targetsRepo).execute('2026-01', '2026-02');

    expect(result.inflationBaseYearMonth).toBe('');
    expect(result.realSeriesMissingMonths).toEqual(['2026-01', '2026-02']);
    expect(result.months.every((m) => m.mrrFinalRealArs === null && m.revenueTotalRealArs === null)).toBe(true);
    // Does NOT crash, does NOT invent a base — nominal series is still complete.
    expect(result.months).toHaveLength(2);
  });

  it('a month with no FinanceMonthlySnapshot row is dropped from `months` and listed in `monthsWithoutSnapshot`, never a row of zeros', async () => {
    const snapshotRepo = new InMemoryFinanceMonthlySnapshotRepository();
    // Only January has a snapshot — February/March never ran (nightly job only covers current+previous, no backfill yet).
    await seedSnapshots(snapshotRepo, [makeSnapshot('2026-01')]);
    const inflationRepo = new InMemoryFinanceInflationIndexRepository();
    const targetsRepo = new InMemoryFinanceTargetsConfigRepository();
    targetsRepo.seed({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });

    const result = await new GetFinanceOverview(snapshotRepo, inflationRepo, targetsRepo).execute('2026-01', '2026-03');

    expect(result.months.map((m) => m.yearMonth)).toEqual(['2026-01']);
    expect(result.monthsWithoutSnapshot).toEqual(['2026-02', '2026-03']);
  });

  it('propagates churnRevenuePct/collectionRatePct null straight through — never coerced to 0', async () => {
    const snapshotRepo = new InMemoryFinanceMonthlySnapshotRepository();
    await seedSnapshots(snapshotRepo, [makeSnapshot('2026-01', { churnRevenuePct: null, collectionRatePct: null })]);
    const inflationRepo = new InMemoryFinanceInflationIndexRepository();
    const targetsRepo = new InMemoryFinanceTargetsConfigRepository();

    const result = await new GetFinanceOverview(snapshotRepo, inflationRepo, targetsRepo).execute('2026-01', '2026-01');

    expect(result.months[0].churnRevenuePct).toBeNull();
    expect(result.months[0].collectionRatePct).toBeNull();
  });

  it('rejects a malformed "from"/"to" and "from" > "to" without querying anything', async () => {
    const snapshotRepo = new InMemoryFinanceMonthlySnapshotRepository();
    const useCase = new GetFinanceOverview(snapshotRepo, new InMemoryFinanceInflationIndexRepository(), new InMemoryFinanceTargetsConfigRepository());
    await expect(useCase.execute('2026-1', '2026-03')).rejects.toThrow();
    await expect(useCase.execute('2026-03', '2026-01')).rejects.toThrow();
  });

  it('fix-wave-4 🔵17 — rejects a range wider than 240 months (e.g. 1990-01..2026-12), a defensive cap against a fat-fingered request', async () => {
    const snapshotRepo = new InMemoryFinanceMonthlySnapshotRepository();
    const useCase = new GetFinanceOverview(snapshotRepo, new InMemoryFinanceInflationIndexRepository(), new InMemoryFinanceTargetsConfigRepository());
    await expect(useCase.execute('1990-01', '2026-12')).rejects.toThrow();
  });
});

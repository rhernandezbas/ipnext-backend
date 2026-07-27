import { BackfillFinanceMonthlySnapshots } from '@application/use-cases/finance/BackfillFinanceMonthlySnapshots';
import type { BuildFinanceMonthlySnapshot } from '@application/use-cases/finance/BuildFinanceMonthlySnapshot';
import type { BuildFinanceCohortSnapshot } from '@application/use-cases/finance/BuildFinanceCohortSnapshot';

function fakeMonthly(calls: string[], failOn?: Set<string>): BuildFinanceMonthlySnapshot {
  return {
    execute: jest.fn(async (ym: string) => {
      calls.push(ym);
      if (failOn?.has(ym)) throw new Error(`boom(${ym})`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { yearMonth: ym } as any;
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeCohort(calls: string[]): BuildFinanceCohortSnapshot {
  return {
    execute: jest.fn(async (ym: string) => {
      calls.push(ym);
      return [];
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/**
 * finance-growth Fase 3 rework (J1) — `FinanceSnapshotScheduler` is the
 * ONLY production call site of `BuildFinanceMonthlySnapshot.execute()`, and
 * it only ever computes current+previous month. Without a backfill trigger,
 * `FinanceMonthlySnapshot` never has rows for any older month, no matter how
 * much receipt history Fase 1 backfills — this use case is that trigger.
 */
describe('BackfillFinanceMonthlySnapshots (J1 — the missing manual backfill trigger)', () => {
  it('computes both the monthly AND cohort snapshot for every month in an inclusive range, ascending', async () => {
    const monthlyCalls: string[] = [];
    const cohortCalls: string[] = [];
    const uc = new BackfillFinanceMonthlySnapshots(fakeMonthly(monthlyCalls), fakeCohort(cohortCalls));

    const result = await uc.execute('2026-01', '2026-03');

    expect(monthlyCalls).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(cohortCalls).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(result.monthsComputed).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(result.monthsFailed).toEqual([]);
  });

  it('a single month failing does not abort the rest of the range (mirrors FinanceSnapshotScheduler resilience)', async () => {
    const monthlyCalls: string[] = [];
    const cohortCalls: string[] = [];
    const uc = new BackfillFinanceMonthlySnapshots(fakeMonthly(monthlyCalls, new Set(['2026-02'])), fakeCohort(cohortCalls));

    const result = await uc.execute('2026-01', '2026-03');

    expect(monthlyCalls).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(result.monthsComputed).toEqual(['2026-01', '2026-03']);
    expect(result.monthsFailed).toEqual([{ yearMonth: '2026-02', error: 'boom(2026-02)' }]);
    // the poisoned month's cohort computation never runs (monthly failed first) — 2026-02 excluded from cohort calls too
    expect(cohortCalls).toEqual(['2026-01', '2026-03']);
  });

  it('handles a range spanning a calendar year boundary', async () => {
    const monthlyCalls: string[] = [];
    const uc = new BackfillFinanceMonthlySnapshots(fakeMonthly(monthlyCalls), fakeCohort([]));

    await uc.execute('2025-11', '2026-02');

    expect(monthlyCalls).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('rejects an invalid "from"/"to" without calling either builder', async () => {
    const monthlyCalls: string[] = [];
    const uc = new BackfillFinanceMonthlySnapshots(fakeMonthly(monthlyCalls), fakeCohort([]));

    await expect(uc.execute('2026-13', '2026-03')).rejects.toThrow(/YYYY-MM/);
    await expect(uc.execute('2026-01', 'garbage')).rejects.toThrow(/YYYY-MM/);
    expect(monthlyCalls).toEqual([]);
  });

  it('rejects a range where "from" is after "to"', async () => {
    const uc = new BackfillFinanceMonthlySnapshots(fakeMonthly([]), fakeCohort([]));

    await expect(uc.execute('2026-05', '2026-01')).rejects.toThrow(/from.*<=.*to/);
  });

  it('rejects a range exceeding the defensive per-run cap without computing anything', async () => {
    const monthlyCalls: string[] = [];
    const uc = new BackfillFinanceMonthlySnapshots(fakeMonthly(monthlyCalls), fakeCohort([]));

    await expect(uc.execute('1900-01', '2026-01')).rejects.toThrow(/máximo/);
    expect(monthlyCalls).toEqual([]);
  });

  /**
   * fix-wave-3 (🔵 5, backfill sin techo temporal) — without this guard, a
   * `to` in the future (e.g. a fat-fingered `2030-12`, or a FE bug building
   * the range) would compute and PERSIST snapshots for months that haven't
   * happened yet — every one of them zero (`BuildFinanceMonthlySnapshot`
   * finds no `ContractServiceEvent`/cash for a future month, so it returns
   * an honestly-empty-but-WRONG row), which `GetFinanceOverview` would then
   * read as a cliff-drop to zero at the end of the series.
   */
  describe('fix-wave-3 (🔵 5) — "to" cannot be in the future', () => {
    it('rejects a "to" beyond the current month without computing anything', async () => {
      const monthlyCalls: string[] = [];
      const uc = new BackfillFinanceMonthlySnapshots(fakeMonthly(monthlyCalls), fakeCohort([]), () => new Date('2026-07-27T12:00:00.000Z'));

      await expect(uc.execute('2026-01', '2030-12')).rejects.toThrow(/futuro|actual/);
      expect(monthlyCalls).toEqual([]);
    });

    it('accepts a "to" exactly equal to the current month', async () => {
      const monthlyCalls: string[] = [];
      const uc = new BackfillFinanceMonthlySnapshots(fakeMonthly(monthlyCalls), fakeCohort([]), () => new Date('2026-07-27T12:00:00.000Z'));

      const result = await uc.execute('2026-06', '2026-07');

      expect(result.monthsComputed).toEqual(['2026-06', '2026-07']);
    });

    it('accepts any "to" in the past without requiring the caller to inject a clock', async () => {
      const monthlyCalls: string[] = [];
      // no `now` injected — defaults to the real system clock, well past 2026-03.
      const uc = new BackfillFinanceMonthlySnapshots(fakeMonthly(monthlyCalls), fakeCohort([]));

      const result = await uc.execute('2026-01', '2026-03');

      expect(result.monthsComputed).toEqual(['2026-01', '2026-02', '2026-03']);
    });
  });
});

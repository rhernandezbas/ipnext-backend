import { FinanceSnapshotScheduler } from '@infrastructure/scheduling/FinanceSnapshotScheduler';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import type { BuildFinanceMonthlySnapshot } from '@application/use-cases/finance/BuildFinanceMonthlySnapshot';
import type { BuildFinanceCohortSnapshot } from '@application/use-cases/finance/BuildFinanceCohortSnapshot';

function fakeBuildMonthly(calls: string[]): BuildFinanceMonthlySnapshot {
  return {
    execute: jest.fn(async (ym: string) => {
      calls.push(ym);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { yearMonth: ym } as any;
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function fakeBuildCohort(calls: string[], rowsFor: (ym: string) => number): BuildFinanceCohortSnapshot {
  return {
    execute: jest.fn(async (ym: string) => {
      calls.push(ym);
      const n = rowsFor(ym);
      return Array.from({ length: n }, () => ({}));
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('FinanceSnapshotScheduler (design.md Wiring — nightly monthly/cohort snapshot job)', () => {
  it('recomputes the current AND previous calendar month (AR), and walks the cohort lookback window', async () => {
    const monthlyCalls: string[] = [];
    const cohortCalls: string[] = [];
    const scheduler = new FinanceSnapshotScheduler(
      fakeBuildMonthly(monthlyCalls),
      fakeBuildCohort(cohortCalls, () => 1),
      { intervalMs: 999999, cohortLookbackMonths: 3, silent: true },
      new InMemoryDistributedLock(),
      () => new Date('2026-03-15T15:00:00.000Z'),
    );

    const summary = await scheduler.runOnce();

    expect(monthlyCalls).toEqual(['2026-02', '2026-03']);
    expect(cohortCalls).toEqual(['2026-02', '2026-01', '2025-12']);
    expect(summary.monthsComputed).toEqual(['2026-02', '2026-03']);
    expect(summary.errors).toBeUndefined();
  });

  it('skips the tick entirely when the lock is held by another instance', async () => {
    const monthlyCalls: string[] = [];
    const lock = new InMemoryDistributedLock();
    lock.forceAcquireFails = true;
    const scheduler = new FinanceSnapshotScheduler(
      fakeBuildMonthly(monthlyCalls),
      fakeBuildCohort([], () => 0),
      { intervalMs: 999999, silent: true },
      lock,
      () => new Date('2026-03-15T15:00:00.000Z'),
    );

    const summary = await scheduler.runOnce();

    expect(summary.skipped).toBe(true);
    expect(monthlyCalls).toEqual([]);
  });

  it('a single month failing does not abort the rest of the tick (one poisoned month, others still computed)', async () => {
    const cohortCalls: string[] = [];
    const buildMonthly = {
      execute: jest.fn(async (ym: string) => {
        if (ym === '2026-02') throw new Error('boom');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { yearMonth: ym } as any;
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const scheduler = new FinanceSnapshotScheduler(
      buildMonthly,
      fakeBuildCohort(cohortCalls, () => 0),
      { intervalMs: 999999, cohortLookbackMonths: 1, silent: true },
      new InMemoryDistributedLock(),
      () => new Date('2026-03-15T15:00:00.000Z'),
    );

    const summary = await scheduler.runOnce();

    expect(summary.monthsComputed).toEqual(['2026-03']);
    expect(summary.errors?.[0]).toContain('2026-02');
  });

  it('releases the lock even when a tick throws before completing', async () => {
    const lock = new InMemoryDistributedLock();
    const buildMonthly = { execute: jest.fn(async () => ({})) } as never;
    const buildCohort = {
      execute: jest.fn(async () => {
        throw new Error('cohort boom');
      }),
    } as never;
    const scheduler = new FinanceSnapshotScheduler(
      buildMonthly,
      buildCohort,
      { intervalMs: 999999, cohortLookbackMonths: 1, silent: true },
      lock,
      () => new Date('2026-03-15T15:00:00.000Z'),
    );

    await scheduler.runOnce();
    expect(lock.heldKeys.size).toBe(0);
  });
});

describe('FinanceSnapshotScheduler — J3: persists its own run status (was: NONE at all)', () => {
  it('a successful tick persists lastResult "ok" and itemsSynced = months computed', async () => {
    const state = new InMemorySyncStateRepository();
    const scheduler = new FinanceSnapshotScheduler(
      fakeBuildMonthly([]),
      fakeBuildCohort([], () => 0),
      { intervalMs: 999999, cohortLookbackMonths: 0, silent: true },
      new InMemoryDistributedLock(),
      () => new Date('2026-03-15T15:00:00.000Z'),
      state,
    );

    await scheduler.runOnce();

    const saved = await state.get('finance-snapshot-job');
    expect(saved?.lastResult).toBe('ok');
    expect(saved?.itemsSynced).toBe(2); // previous + current month
    expect(saved?.lastRunAt).toEqual(new Date('2026-03-15T15:00:00.000Z'));
  });

  it('a tick with a poisoned month persists an "error:" result — a fully-dead job is no longer indistinguishable from "nothing changed"', async () => {
    const state = new InMemorySyncStateRepository();
    const buildMonthly = {
      execute: jest.fn(async (ym: string) => {
        throw new Error(`boom(${ym})`);
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const scheduler = new FinanceSnapshotScheduler(
      buildMonthly,
      fakeBuildCohort([], () => 0),
      { intervalMs: 999999, cohortLookbackMonths: 0, silent: true },
      new InMemoryDistributedLock(),
      () => new Date('2026-03-15T15:00:00.000Z'),
      state,
    );

    await scheduler.runOnce();

    const saved = await state.get('finance-snapshot-job');
    expect(saved?.lastResult).toMatch(/^error:/);
  });

  it('a skipped tick (lock held elsewhere) does NOT persist a status (no run actually happened)', async () => {
    const state = new InMemorySyncStateRepository();
    const lock = new InMemoryDistributedLock();
    lock.forceAcquireFails = true;
    const scheduler = new FinanceSnapshotScheduler(
      fakeBuildMonthly([]),
      fakeBuildCohort([], () => 0),
      { intervalMs: 999999, silent: true },
      lock,
      () => new Date('2026-03-15T15:00:00.000Z'),
      state,
    );

    await scheduler.runOnce();

    expect(await state.get('finance-snapshot-job')).toBeNull();
  });

  it('runs fine with NO state repo threaded in (optional — existing callers/tests keep working)', async () => {
    const scheduler = new FinanceSnapshotScheduler(
      fakeBuildMonthly([]),
      fakeBuildCohort([], () => 0),
      { intervalMs: 999999, cohortLookbackMonths: 0, silent: true },
      new InMemoryDistributedLock(),
      () => new Date('2026-03-15T15:00:00.000Z'),
    );

    await expect(scheduler.runOnce()).resolves.toBeDefined();
  });
});

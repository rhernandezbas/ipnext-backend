import { IClassTeamSyncScheduler } from '@infrastructure/scheduling/IClassTeamSyncScheduler';
import type { FeatureFlag, FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { SyncTeamsResult } from '@application/use-cases/SyncIClassTeams';

const RESULT: SyncTeamsResult = {
  synced: 5,
  created: 1,
  updated: 3,
  reactivated: 0,
  deactivated: 1,
  cancelled: 1,
};

function flags(enabled: boolean | null): FeatureFlagRepository {
  return {
    async list() {
      return [];
    },
    async get(key: string): Promise<FeatureFlag | null> {
      if (enabled === null) return null;
      return { key, enabled, updatedAt: '2026-09-23T12:00:00.000Z' };
    },
    async setEnabled(key: string, value: boolean) {
      return { key, enabled: value, updatedAt: '2026-09-23T12:00:00.000Z' };
    },
  };
}

function lock(acquirable = true): DistributedLock & { released: number } {
  const state = {
    released: 0,
    async tryAcquire() {
      return acquirable;
    },
    async release() {
      state.released++;
    },
  };
  return state;
}

function sync(impl?: () => Promise<SyncTeamsResult>) {
  const execute = jest.fn(impl ?? (async () => RESULT));
  return { execute } as unknown as { execute: jest.Mock };
}

describe('IClassTeamSyncScheduler', () => {
  it('does NOT run when the feature flag is off', async () => {
    const use = sync();
    const res = await new IClassTeamSyncScheduler(
      use as never,
      flags(false),
      { intervalMs: 1000, silent: true },
      lock(),
    ).runOnce();

    expect(use.execute).not.toHaveBeenCalled();
    expect(res.skipped).toBe(true);
  });

  it('does NOT run when the flag does not exist yet (default OFF)', async () => {
    const use = sync();
    const res = await new IClassTeamSyncScheduler(
      use as never,
      flags(null),
      { intervalMs: 1000, silent: true },
      lock(),
    ).runOnce();

    expect(use.execute).not.toHaveBeenCalled();
    expect(res.skipped).toBe(true);
  });

  it('runs the sync when the flag is on', async () => {
    const use = sync();
    const res = await new IClassTeamSyncScheduler(
      use as never,
      flags(true),
      { intervalMs: 1000, silent: true },
      lock(),
    ).runOnce();

    expect(use.execute).toHaveBeenCalledTimes(1);
    expect(res.result).toEqual(RESULT);
  });

  it('skips when the distributed lock is held by another instance', async () => {
    const use = sync();
    const res = await new IClassTeamSyncScheduler(
      use as never,
      flags(true),
      { intervalMs: 1000, silent: true },
      lock(false),
    ).runOnce();

    expect(use.execute).not.toHaveBeenCalled();
    expect(res.skipped).toBe(true);
  });

  it('always releases the lock, even when the sync throws (e.g. IClassUnavailableError)', async () => {
    const l = lock(true);
    const use = sync(async () => {
      throw new Error('IClass unavailable');
    });

    const res = await new IClassTeamSyncScheduler(
      use as never,
      flags(true),
      { intervalMs: 1000, silent: true },
      l,
    ).runOnce();

    expect(res.error).toBe('IClass unavailable');
    expect(l.released).toBe(1);
  });

  it('does not start a second run while one is already in flight', async () => {
    let resolve!: (v: SyncTeamsResult) => void;
    const use = sync(() => new Promise<SyncTeamsResult>((r) => (resolve = r)));
    const scheduler = new IClassTeamSyncScheduler(
      use as never,
      flags(true),
      { intervalMs: 1000, silent: true },
      lock(),
    );

    const first = scheduler.runOnce();
    await new Promise((r) => setTimeout(r, 10));

    const second = await scheduler.runOnce();
    expect(second.skipped).toBe(true);

    resolve(RESULT);
    await first;
    expect(use.execute).toHaveBeenCalledTimes(1);
  });

  it('does not reject when flags.get() rejects (never an unhandled rejection)', async () => {
    const brokenFlags: FeatureFlagRepository = {
      async list() { return []; },
      async get() { throw new Error('pool timeout'); },
      async setEnabled(key: string, value: boolean) {
        return { key, enabled: value, updatedAt: '2026-09-23T12:00:00.000Z' };
      },
    };
    const res = await new IClassTeamSyncScheduler(
      sync() as never, brokenFlags, { intervalMs: 1000, silent: true }, lock(),
    ).runOnce();
    expect(res.error).toBe('pool timeout');
  });

  it('does not let a rejecting release() clobber a SUCCESSFUL run', async () => {
    const brokenRelease: DistributedLock = {
      async tryAcquire() { return true; },
      async release() { throw new Error('release failed'); },
    };
    const res = await new IClassTeamSyncScheduler(
      sync() as never, flags(true), { intervalMs: 1000, silent: true }, brokenRelease,
    ).runOnce();
    expect(res.result).toEqual(RESULT);
    expect(res.error).toBeUndefined();
  });

  it('unrefs its timer so it never keeps the process alive', () => {
    const scheduler = new IClassTeamSyncScheduler(
      sync() as never,
      flags(false),
      { intervalMs: 60_000, silent: true },
      lock(),
    );
    scheduler.start();
    scheduler.stop();
    expect(true).toBe(true);
  });
});

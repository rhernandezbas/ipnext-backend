/**
 * UispSyncScheduler unit tests — SCEN-SYNC-01..04 + FIX-2a + FIX-4.
 * All dependencies are stubbed — no DB, no UISP calls.
 */
import { UispSyncScheduler } from '../../infrastructure/scheduling/UispSyncScheduler';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemorySyncStateRepository } from '../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { UispUnavailableError } from '../../domain/errors/uisp';
import type { SyncUispMirror } from '../../application/use-cases/SyncUispMirror';

const FLAG_KEY = 'uisp-sync';

function lockStub(acquired = true) {
  return { tryAcquire: jest.fn().mockResolvedValue(acquired), release: jest.fn().mockResolvedValue(undefined) } as never;
}

function syncStub(result?: Partial<ReturnType<SyncUispMirror['execute']>> | Error) {
  if (result instanceof Error) {
    return { execute: jest.fn().mockRejectedValue(result) } as unknown as SyncUispMirror;
  }
  return {
    execute: jest.fn().mockResolvedValue({
      sitesUpserted: 1,
      devicesUpserted: 5,
      sitesMissing: 0,
      devicesMissing: 0,
      sitesReappeared: 0,
      devicesReappeared: 0,
      durationMs: 100,
      ...result,
    }),
  } as unknown as SyncUispMirror;
}

function makeScheduler(
  sync: SyncUispMirror,
  flags: InMemoryFeatureFlagRepository,
  syncStateRepo?: InMemorySyncStateRepository,
) {
  return new UispSyncScheduler(sync, flags, lockStub(true), { intervalMs: 1000, silent: true }, syncStateRepo);
}

describe('UispSyncScheduler', () => {
  // SCEN-SYNC-01: flag OFF → no call to SyncUispMirror
  it('SCEN-SYNC-01: skips when uisp-sync flag is OFF', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    // flag not seeded → effectively disabled
    const sync = syncStub();
    const s = new UispSyncScheduler(sync, flags, lockStub(true), {
      intervalMs: 1000,
      silent: true,
    });

    const result = await s.runOnce();
    expect(result.skipped).toBe(true);
    expect(sync.execute).not.toHaveBeenCalled();
  });

  // SCEN-SYNC-02: lock held → skip
  it('SCEN-SYNC-02: skips when the advisory lock is held by another instance', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    const sync = syncStub();
    const s = new UispSyncScheduler(sync, flags, lockStub(false), {
      intervalMs: 1000,
      silent: true,
    });

    const result = await s.runOnce();
    expect(result.skipped).toBe(true);
    expect(sync.execute).not.toHaveBeenCalled();
  });

  // SCEN-SYNC-03: env absent → graceful skip
  it('SCEN-SYNC-03: skips gracefully when sync is not provided (null)', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    const s = new UispSyncScheduler(null as unknown as SyncUispMirror, flags, lockStub(true), {
      intervalMs: 1000,
      silent: true,
    });

    const result = await s.runOnce();
    expect(result.skipped).toBe(true);
  });

  // SCEN-SYNC-04: UISP 5xx → mirror intact, lastError updated
  it('SCEN-SYNC-04: UISP unavailable → logs error, returns error result, mirror not corrupted', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    const sync = syncStub(new UispUnavailableError('UISP 5xx'));
    const s = new UispSyncScheduler(sync, flags, lockStub(true), {
      intervalMs: 1000,
      silent: true,
    });

    const result = await s.runOnce();
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/UISP/i);
    // No throw — error is captured
    expect(result.skipped).toBeUndefined();
  });

  // triggerNow: flag OFF → queued: false, reason: flag-disabled
  it('triggerNow returns { queued: false, reason: flag-disabled } when flag is OFF', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    const sync = syncStub();
    const s = new UispSyncScheduler(sync, flags, lockStub(true), {
      intervalMs: 1000,
      silent: true,
    });

    const result = await s.triggerNow();
    expect(result).toEqual({ queued: false, reason: 'flag-disabled' });
  });

  // triggerNow: inFlight → queued: false, reason: already-running
  it('triggerNow returns { queued: false, reason: already-running } when already running', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    let releaseLock: (() => void) | undefined;
    const blockingSync = {
      execute: jest.fn().mockImplementation(
        () => new Promise<void>(resolve => { releaseLock = resolve; }),
      ),
    } as unknown as SyncUispMirror;
    const s = new UispSyncScheduler(blockingSync, flags, lockStub(true), {
      intervalMs: 1000,
      silent: true,
    });

    // Start a run (fire-and-forget)
    const firstRun = s.runOnce();

    // Give the event loop a tick so inFlight gets set
    await new Promise(r => setTimeout(r, 0));

    const result = await s.triggerNow();
    expect(result).toEqual({ queued: false, reason: 'already-running' });

    // Clean up
    releaseLock?.();
    await firstRun;
  });

  // triggerNow: flag ON, not in flight → queued: true
  it('triggerNow returns { queued: true } when flag is ON and not in flight', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    const sync = syncStub();
    const s = new UispSyncScheduler(sync, flags, lockStub(true), {
      intervalMs: 1000,
      silent: true,
    });

    const result = await s.triggerNow();
    expect(result).toEqual({ queued: true });
  });

  // FIX-2a: UISP failure → SyncState persisted with lastResult='error: <msg>'
  it('FIX-2a: UISP unavailable → SyncState persisted with lastResult error', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    const syncState = new InMemorySyncStateRepository();
    const sync = syncStub(new UispUnavailableError('UISP connection refused'));
    const s = makeScheduler(sync, flags, syncState);

    const result = await s.runOnce();
    expect(result.error).toBeDefined();

    // SyncState must have been persisted with the error
    const state = await syncState.get('uisp-mirror');
    expect(state).not.toBeNull();
    expect(state?.lastResult).toMatch(/^error:/);
    expect(state?.lastResult).toContain('UISP connection refused');
    expect(state?.lastRunAt).toBeInstanceOf(Date);
  });

  // FIX-4: race intra-process — inFlight set SYNCHRONOUSLY before first await
  it('FIX-4: two concurrent runOnce calls → only one executes', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    let resolveSync: ((v: { sitesUpserted: number; devicesUpserted: number; sitesMissing: number; devicesMissing: number; sitesReappeared: number; devicesReappeared: number; durationMs: number }) => void) | undefined;
    const blockingSync = {
      execute: jest.fn().mockImplementation(
        () => new Promise<{
          sitesUpserted: number; devicesUpserted: number; sitesMissing: number; devicesMissing: number;
          sitesReappeared: number; devicesReappeared: number; durationMs: number;
        }>(resolve => {
          resolveSync = resolve;
        }),
      ),
    } as unknown as SyncUispMirror;

    const s = new UispSyncScheduler(blockingSync, flags, lockStub(true), { intervalMs: 1000, silent: true });

    // Launch first runOnce — sets inFlight=true synchronously before any await
    const first = s.runOnce();

    // Give one microtask tick so the first call sets inFlight=true (synchronous before try-block entry)
    await Promise.resolve();

    // Second call must see inFlight=true and skip
    const second = s.runOnce();

    // Let the second resolve immediately (it returned { skipped: true } already)
    const r2 = await second;

    // Now unblock the first
    await new Promise(res => setTimeout(res, 0)); // ensure sync.execute was called
    resolveSync?.({ sitesUpserted: 1, devicesUpserted: 1, sitesMissing: 0, devicesMissing: 0, sitesReappeared: 0, devicesReappeared: 0, durationMs: 10 });
    const r1 = await first;

    // Exactly one should have run (not skipped), the other should be skipped
    expect(r1.skipped).toBeUndefined();
    expect(r2.skipped).toBe(true);
    expect(blockingSync.execute).toHaveBeenCalledTimes(1);
  });
});

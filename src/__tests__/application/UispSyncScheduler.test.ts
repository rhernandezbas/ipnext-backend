/**
 * UispSyncScheduler unit tests — SCEN-SYNC-01..04 + FIX-2a + FIX-4.
 * All dependencies are stubbed — no DB, no UISP calls.
 */
import { UispSyncScheduler } from '../../infrastructure/scheduling/UispSyncScheduler';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemorySyncStateRepository } from '../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { UispUnavailableError } from '../../domain/errors/uisp';
import type { SyncUispMirror } from '../../application/use-cases/SyncUispMirror';
import type { AutoAssignContractNetwork, AutoAssignContractNetworkResult } from '../../application/use-cases/AutoAssignContractNetwork';

const FLAG_KEY = 'uisp-sync';
const AUTO_ASSIGN_FLAG_KEY = 'contract-network-auto-assign';

function autoAssignStub(resultOrError?: Partial<AutoAssignContractNetworkResult> | Error): AutoAssignContractNetwork {
  if (resultOrError instanceof Error) {
    return { execute: jest.fn().mockRejectedValue(resultOrError) } as unknown as AutoAssignContractNetwork;
  }
  return {
    execute: jest.fn().mockResolvedValue({
      contractsEvaluated: 0,
      assigned: 0,
      unchanged: 0,
      unresolved: 0,
      ambiguous: 0,
      macFromCallerId: 0,
      macFromRadiusEvent: 0,
      durationMs: 5,
      ...resultOrError,
    }),
  } as unknown as AutoAssignContractNetwork;
}

function lockStub(acquired = true) {
  return { tryAcquire: jest.fn().mockResolvedValue(acquired), release: jest.fn().mockResolvedValue(undefined) } as never;
}

function syncStub(result?: Partial<Awaited<ReturnType<SyncUispMirror['execute']>>> | Error) {
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
    let resolveSync: ((v: { sitesUpserted: number; devicesUpserted: number; sitesMissing: number; devicesMissing: number; sitesReappeared: number; devicesReappeared: number; durationMs: number; networkSitesCreated: number }) => void) | undefined;
    const blockingSync = {
      execute: jest.fn().mockImplementation(
        () => new Promise<{
          sitesUpserted: number; devicesUpserted: number; sitesMissing: number; devicesMissing: number;
          sitesReappeared: number; devicesReappeared: number; durationMs: number; networkSitesCreated: number;
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
    resolveSync?.({ sitesUpserted: 1, devicesUpserted: 1, sitesMissing: 0, devicesMissing: 0, sitesReappeared: 0, devicesReappeared: 0, durationMs: 10, networkSitesCreated: 0 });
    const r1 = await first;

    // Exactly one should have run (not skipped), the other should be skipped
    expect(r1.skipped).toBeUndefined();
    expect(r2.skipped).toBe(true);
    expect(blockingSync.execute).toHaveBeenCalledTimes(1);
  });
});

// contract-node-ap-auto-assign (AA-5) — post-sync auto-assign step, gated by its OWN flag,
// isolated try/catch (a throw here must NEVER break the sync's own result), invoked INSIDE
// the advisory lock scope (before `finally { release }`).
describe('UispSyncScheduler — auto-assign step (AA-5)', () => {
  it('flag ON: invoca autoAssign tras un sync exitoso, DENTRO del lock (antes de liberarlo)', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    flags.seed(AUTO_ASSIGN_FLAG_KEY, true);
    const sync = syncStub();
    const autoAssign = autoAssignStub({ assigned: 3, unresolved: 1 });
    const lock = { tryAcquire: jest.fn().mockResolvedValue(true), release: jest.fn().mockResolvedValue(undefined) };
    const s = new UispSyncScheduler(sync, flags, lock as never, { intervalMs: 1000, silent: true }, undefined, autoAssign);

    await s.runOnce();

    expect(autoAssign.execute).toHaveBeenCalledTimes(1);
    const executeOrder = (autoAssign.execute as jest.Mock).mock.invocationCallOrder[0]!;
    const releaseOrder = (lock.release as jest.Mock).mock.invocationCallOrder[0]!;
    expect(executeOrder).toBeLessThan(releaseOrder);
  });

  it('flag OFF: NO invoca autoAssign', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    flags.seed(AUTO_ASSIGN_FLAG_KEY, false);
    const sync = syncStub();
    const autoAssign = autoAssignStub();
    const s = new UispSyncScheduler(sync, flags, lockStub(true), { intervalMs: 1000, silent: true }, undefined, autoAssign);

    await s.runOnce();

    expect(autoAssign.execute).not.toHaveBeenCalled();
  });

  it('flag AUSENTE (nunca seedeado): NO invoca autoAssign — dark by default', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    // contract-network-auto-assign NUNCA seedeado.
    const sync = syncStub();
    const autoAssign = autoAssignStub();
    const s = new UispSyncScheduler(sync, flags, lockStub(true), { intervalMs: 1000, silent: true }, undefined, autoAssign);

    await s.runOnce();

    expect(autoAssign.execute).not.toHaveBeenCalled();
  });

  it('autoAssign que LANZA: el resultado del sync se reporta igual (aislado, no rompe el run)', async () => {
    // review INFO(c): mockeamos console.warn — el catch aislado del scheduler lo llama a
    // propósito (`[uisp-sync] auto-assign step failed: ...`), y sin el mock ensucia el output
    // real del test runner con un warning esperado (no es una señal de fallo).
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    flags.seed(AUTO_ASSIGN_FLAG_KEY, true);
    const sync = syncStub({ sitesUpserted: 2, devicesUpserted: 9 });
    const autoAssign = autoAssignStub(new Error('auto-assign boom'));
    const s = new UispSyncScheduler(sync, flags, lockStub(true), { intervalMs: 1000, silent: true }, undefined, autoAssign);

    const result = await s.runOnce();

    expect(result.error).toBeUndefined();
    expect(result.sitesUpserted).toBe(2);
    expect(result.devicesUpserted).toBe(9);
    expect(autoAssign.execute).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('ctor SIN autoAssign (6to arg omitido): no-op total, back-compat con todos los call-sites existentes', async () => {
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed(FLAG_KEY, true);
    flags.seed(AUTO_ASSIGN_FLAG_KEY, true);
    const sync = syncStub();
    const s = new UispSyncScheduler(sync, flags, lockStub(true), { intervalMs: 1000, silent: true });

    const result = await s.runOnce();

    expect(result.error).toBeUndefined();
    expect(result.skipped).toBeUndefined();
  });
});

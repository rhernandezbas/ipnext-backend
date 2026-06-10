/**
 * GetUispSyncStatus — SCEN-API-06 + FIX-2b (counts contract + lastError).
 */
import { GetUispSyncStatus } from '../../../application/use-cases/GetUispSyncStatus';
import { InMemorySyncStateRepository } from '../../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryFeatureFlagRepository } from '../../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';

describe('GetUispSyncStatus', () => {
  // SCEN-API-06: null lastRunAt when never run
  it('SCEN-API-06: returns lastRunAt=null when mirror has never been synced', async () => {
    const syncState = new InMemorySyncStateRepository();
    const flags = new InMemoryFeatureFlagRepository();

    const uc = new GetUispSyncStatus(syncState, flags, false);
    const result = await uc.execute();

    expect(result.lastRunAt).toBeNull();
    expect(result.configured).toBe(false);
    expect(result.enabled).toBe(false);
  });

  it('returns configured=true when UISP env are set', async () => {
    const syncState = new InMemorySyncStateRepository();
    const flags = new InMemoryFeatureFlagRepository();

    const uc = new GetUispSyncStatus(syncState, flags, true);
    const result = await uc.execute();

    expect(result.configured).toBe(true);
  });

  it('returns enabled=true when uisp-sync flag is ON', async () => {
    const syncState = new InMemorySyncStateRepository();
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed('uisp-sync', true);

    const uc = new GetUispSyncStatus(syncState, flags, true);
    const result = await uc.execute();

    expect(result.enabled).toBe(true);
  });

  it('returns last sync data when mirror has been run', async () => {
    const syncState = new InMemorySyncStateRepository();
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed('uisp-sync', true);

    const lastRunAt = new Date('2026-06-10T12:00:00Z');
    await syncState.save({
      entity: 'uisp-mirror',
      cursor: null,
      lastRunAt,
      lastResult: 'ok: {"sites":73,"devices":4009,"missing":0}',
      itemsSynced: 4082,
    });

    const uc = new GetUispSyncStatus(syncState, flags, true);
    const result = await uc.execute();

    expect(result.lastRunAt).toEqual(lastRunAt);
    expect(result.lastResult).toContain('ok');
    expect(result.itemsSynced).toBe(4082);
  });

  // FIX-2b: counts parsed from ok: {...} JSON in lastResult
  it('FIX-2b: parses sites/devices/missing/durationMs from ok: {...} lastResult', async () => {
    const syncState = new InMemorySyncStateRepository();
    const flags = new InMemoryFeatureFlagRepository();

    await syncState.save({
      entity: 'uisp-mirror',
      cursor: null,
      lastRunAt: new Date('2026-06-10T12:00:00Z'),
      lastResult: 'ok: {"sites":73,"devices":4009,"missing":2,"durationMs":1200}',
      itemsSynced: 4082,
    });

    const uc = new GetUispSyncStatus(syncState, flags, true);
    const result = await uc.execute();

    expect(result.sites).toBe(73);
    expect(result.devices).toBe(4009);
    expect(result.missing).toBe(2);
    expect(result.durationMs).toBe(1200);
    expect(result.lastError).toBeNull();
  });

  // FIX-2b: old ok: JSON without durationMs → durationMs null (null-safe)
  it('FIX-2b: old ok: JSON without durationMs → durationMs: null (null-safe backward compat)', async () => {
    const syncState = new InMemorySyncStateRepository();
    const flags = new InMemoryFeatureFlagRepository();

    await syncState.save({
      entity: 'uisp-mirror',
      cursor: null,
      lastRunAt: new Date('2026-06-10T12:00:00Z'),
      lastResult: 'ok: {"sites":73,"devices":4009,"missing":0}',
      itemsSynced: 4082,
    });

    const uc = new GetUispSyncStatus(syncState, flags, true);
    const result = await uc.execute();

    expect(result.sites).toBe(73);
    expect(result.durationMs).toBeNull();
    expect(result.lastError).toBeNull();
  });

  // FIX-2b: error: <msg> → lastError populated, counts null
  it('FIX-2b: error: <msg> lastResult → lastError populated, counts are null', async () => {
    const syncState = new InMemorySyncStateRepository();
    const flags = new InMemoryFeatureFlagRepository();

    await syncState.save({
      entity: 'uisp-mirror',
      cursor: null,
      lastRunAt: new Date('2026-06-10T12:00:00Z'),
      lastResult: 'error: UISP connection refused',
      itemsSynced: 0,
    });

    const uc = new GetUispSyncStatus(syncState, flags, true);
    const result = await uc.execute();

    expect(result.lastError).toBe('UISP connection refused');
    expect(result.sites).toBeNull();
    expect(result.devices).toBeNull();
    expect(result.missing).toBeNull();
    expect(result.durationMs).toBeNull();
  });

  // FIX-2b: never run → counts all null, lastError null
  it('FIX-2b: never run → all counts null, lastError null', async () => {
    const syncState = new InMemorySyncStateRepository();
    const flags = new InMemoryFeatureFlagRepository();

    const uc = new GetUispSyncStatus(syncState, flags, false);
    const result = await uc.execute();

    expect(result.sites).toBeNull();
    expect(result.devices).toBeNull();
    expect(result.missing).toBeNull();
    expect(result.durationMs).toBeNull();
    expect(result.lastError).toBeNull();
  });
});

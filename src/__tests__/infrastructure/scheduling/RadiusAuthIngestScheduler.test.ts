import { RadiusAuthIngestScheduler } from '@infrastructure/scheduling/RadiusAuthIngestScheduler';
import { IngestRadiusAuth } from '@application/use-cases/IngestRadiusAuth';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRadiusAuthEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusAuthEventRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';

const FLAG_KEY = 'radius-auth-ingest';
const LOCK_KEY = 'radius-auth-ingest';
const NOW = new Date('2026-06-22T12:00:00Z');

function makeHarness(flagEnabled = true) {
  const gateway    = new InMemoryRadiusOrchestratorGateway({ authEvents: [] });
  const eventRepo  = new InMemoryRadiusAuthEventRepository();
  const stateRepo  = new InMemorySyncStateRepository();
  const flags      = new InMemoryFeatureFlagRepository();
  const lock       = new InMemoryDistributedLock();
  flags.seed(FLAG_KEY, flagEnabled);
  const ingest    = new IngestRadiusAuth(gateway, eventRepo, stateRepo, { now: () => NOW });
  const scheduler = new RadiusAuthIngestScheduler(ingest, { intervalMs: 1000, silent: true }, lock, flags, stateRepo);
  return { gateway, eventRepo, stateRepo, flags, lock, ingest, scheduler };
}

describe('RadiusAuthIngestScheduler', () => {
  it('dark-by-default: flag OFF -> no ingesta, returns skipped', async () => {
    const { scheduler, ingest } = makeHarness(false);
    const spy = jest.spyOn(ingest, 'run');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('ingesta avanza cuando flag ON', async () => {
    const { scheduler } = makeHarness(true);
    const summary = await scheduler.runOnce();
    expect(summary.skipped).toBeUndefined();
    expect(summary.result).toBeDefined();
  });

  it('upsert idempotente: re-correr no duplica registros', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({
      authEvents: [{ sourceId: 'pa-01', username: 'u1', reply: 'Access-Reject', authdate: '2026-06-22T10:00:00Z', class: null, reason: null }],
    });
    const eventRepo = new InMemoryRadiusAuthEventRepository();
    const stateRepo = new InMemorySyncStateRepository();
    const flags     = new InMemoryFeatureFlagRepository();
    const lock      = new InMemoryDistributedLock();
    flags.seed(FLAG_KEY, true);
    const ingest = new IngestRadiusAuth(gateway, eventRepo, stateRepo, { now: () => NOW });
    const sched  = new RadiusAuthIngestScheduler(ingest, { intervalMs: 1000, silent: true }, lock, flags);
    await sched.runOnce();
    await sched.runOnce();
    const stored = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(stored.total).toBe(1);
  });

  it('no corre concurrente: inFlight=true -> skip', async () => {
    const { scheduler } = makeHarness(true);
    const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    const skipped = [a, b].filter(r => r.skipped).length;
    expect(skipped).toBe(1);
  });

  it('lock tomado por otra replica -> skip', async () => {
    const { scheduler, lock, ingest } = makeHarness(true);
    lock.forceAcquireFails = true;
    const spy = jest.spyOn(ingest, 'run');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('best-effort: error del ingest no tira el scheduler (loguea y continua)', async () => {
    const { scheduler, ingest } = makeHarness(true);
    jest.spyOn(ingest, 'run').mockRejectedValueOnce(new Error('boom'));
    const summary = await scheduler.runOnce();
    expect(summary.error).toContain('boom');
  });

  it('libera el lock despues de cada run', async () => {
    const { scheduler, lock } = makeHarness(true);
    const releaseSpy = jest.spyOn(lock, 'release');
    await scheduler.runOnce();
    expect(releaseSpy).toHaveBeenCalledWith(LOCK_KEY);
    expect(lock.heldKeys.has(LOCK_KEY)).toBe(false);
  });

  it('flags.get lanza -> inFlight vuelve a false (proximo tick puede correr)', async () => {
    const { scheduler, flags } = makeHarness(true);
    jest.spyOn(flags, 'get').mockRejectedValueOnce(new Error('flags-db-down'));
    await scheduler.runOnce().catch(() => { /* expected */ });
    const second = await scheduler.runOnce();
    expect(second.skipped).toBeUndefined();
    expect(second.result).toBeDefined();
  });

  it('tryAcquire lanza -> inFlight false + no queda lock colgado', async () => {
    const { scheduler, lock } = makeHarness(true);
    jest.spyOn(lock, 'tryAcquire').mockRejectedValueOnce(new Error('pg-down'));
    await scheduler.runOnce().catch(() => { /* expected */ });
    const second = await scheduler.runOnce();
    expect(second.skipped).toBeUndefined();
    expect(second.result).toBeDefined();
    expect(lock.heldKeys.has(LOCK_KEY)).toBe(false);
  });
});

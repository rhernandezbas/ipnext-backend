import { GestionRealIngestScheduler } from '@infrastructure/scheduling/GestionRealIngestScheduler';
import { IngestGestionRealOrders } from '@application/use-cases/IngestGestionRealOrders';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryGrLinkResolver } from '@infrastructure/adapters/in-memory/InMemoryGrLinkResolver';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryGestionRealIngestConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryProjectRepository } from '@infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryTaskPriorityRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskPriorityRepository';
import { InMemoryTaskCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskCategoryRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';

const DEFAULT_STAGE_ID = '10000000-0000-4000-a000-000000000001';

const INGEST_FLAG_KEY = 'gestion-real-ingest';

interface Harness {
  featureFlags: InMemoryFeatureFlagRepository;
  lock: InMemoryDistributedLock;
  ingest: IngestGestionRealOrders;
  scheduler: GestionRealIngestScheduler;
}

function makeHarness(): Harness {
  const gr = new InMemoryGestionRealPort();
  const resolver = new InMemoryGrLinkResolver();
  const scheduling = new InMemorySchedulingRepository();
  const config = new InMemoryGestionRealIngestConfigRepository();
  const state = new InMemorySyncStateRepository();
  const projects = new InMemoryProjectRepository();
  const featureFlags = new InMemoryFeatureFlagRepository();
  featureFlags.seed(INGEST_FLAG_KEY, true);
  const priorities = new InMemoryTaskPriorityRepository();
  const categories = new InMemoryTaskCategoryRepository();
  // The ingest resolves these catalog entries at the start of each run; seed them.
  void priorities.create({ name: 'Normal', color: '#888', weight: 2 });
  void categories.create({ name: 'Instalación', description: null });
  const lock = new InMemoryDistributedLock();
  const rbacUsers = new InMemoryRbacUserRepository();
  const ingest = new IngestGestionRealOrders(gr, resolver, scheduling, config, state, projects, featureFlags, priorities, categories, rbacUsers, {
    defaultStageId: DEFAULT_STAGE_ID,
    now: () => new Date('2026-05-29T12:00:00Z'),
  });
  const scheduler = new GestionRealIngestScheduler(ingest, { intervalMs: 1000, silent: true }, lock);
  return { featureFlags, lock, ingest, scheduler };
}

describe('GestionRealIngestScheduler', () => {
  it('delegates to the ingest use-case, which no-ops when the master flag is OFF (REQ-SCHED-2)', async () => {
    const h = makeHarness();
    // The single on/off gate is the feature flag, checked inside the use-case.
    h.featureFlags.seed(INGEST_FLAG_KEY, false);
    const spy = jest.spyOn(h.ingest, 'execute');

    const summary = await h.scheduler.runOnce();

    // Scheduler still ticks and delegates; the use-case returns zero counts.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(summary.result).toEqual({
      created: 0,
      skippedDuplicate: 0,
      skippedUnmirrored: 0,
      unclassified: 0,
      skippedOrders: [],
      pregen: { created: 0, existing: 0, stale: 0, failed: 0 },
    });
  });

  it('logs the GR refs of unmirrored skips so the operator can repair without DB access', async () => {
    const h = makeHarness();
    jest.spyOn(h.ingest, 'execute').mockResolvedValueOnce({
      created: 0,
      skippedDuplicate: 0,
      skippedUnmirrored: 2,
      unclassified: 0,
      skippedOrders: [
        { grOrdenId: '17774', grClienteId: '205160', grContratoId: '12064', reason: 'client-unmirrored' },
        { grOrdenId: '17733', grClienteId: '100742', grContratoId: '12038', reason: 'contract-unmirrored' },
      ],
      pregen: { created: 0, existing: 0, stale: 0, failed: 0 },
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const noisy = new GestionRealIngestScheduler(h.ingest, { intervalMs: 1000 }, new InMemoryDistributedLock());

      await noisy.runOnce();

      const logged = logSpy.mock.calls.flat().join('\n');
      expect(logged).toContain('17774');
      expect(logged).toContain('205160');
      expect(logged).toContain('client-unmirrored');
      expect(logged).toContain('17733');
      expect(logged).toContain('contract-unmirrored');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('logs at most 10 skipped refs per tick plus a remainder line (no perpetual log flood)', async () => {
    const h = makeHarness();
    const skippedOrders = Array.from({ length: 12 }, (_, i) => ({
      grOrdenId: String(9000 + i),
      grClienteId: String(100 + i),
      grContratoId: String(200 + i),
      reason: 'client-unmirrored' as const,
    }));
    jest.spyOn(h.ingest, 'execute').mockResolvedValueOnce({
      created: 0,
      skippedDuplicate: 0,
      skippedUnmirrored: 12,
      unclassified: 0,
      skippedOrders,
      pregen: { created: 0, existing: 0, stale: 0, failed: 0 },
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const noisy = new GestionRealIngestScheduler(h.ingest, { intervalMs: 1000 }, new InMemoryDistributedLock());

      await noisy.runOnce();

      const logged = logSpy.mock.calls.flat().join('\n');
      expect(logged).toContain('9000');
      expect(logged).toContain('9009');
      expect(logged).not.toContain('9010');
      expect(logged).not.toContain('9011');
      expect(logged).toContain('2 más');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('runs the ingest once when the lock is free', async () => {
    const h = makeHarness();
    const spy = jest.spyOn(h.ingest, 'execute');

    const summary = await h.scheduler.runOnce();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(summary.result).toBeDefined();
  });

  it('skips the run when the distributed lock is held by another instance (REQ-SCHED-1)', async () => {
    const h = makeHarness();
    h.lock.forceAcquireFails = true;
    const spy = jest.spyOn(h.ingest, 'execute');

    const summary = await h.scheduler.runOnce();

    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('does not start a second run while one is in flight (intra-process guard)', async () => {
    const h = makeHarness();

    const [a, b] = await Promise.all([h.scheduler.runOnce(), h.scheduler.runOnce()]);

    const skipped = [a, b].filter(r => r.skipped).length;
    expect(skipped).toBe(1);
  });

  it('releases the distributed lock after a run (key gr-ingest)', async () => {
    const h = makeHarness();
    const releaseSpy = jest.spyOn(h.lock, 'release');

    await h.scheduler.runOnce();

    expect(releaseSpy).toHaveBeenCalledWith('gr-ingest');
    expect(h.lock.heldKeys.has('gr-ingest')).toBe(false);
  });

  it('swallows ingest errors so the interval keeps ticking', async () => {
    const h = makeHarness();
    jest.spyOn(h.ingest, 'execute').mockRejectedValueOnce(new Error('boom'));

    const summary = await h.scheduler.runOnce();

    expect(summary.error).toContain('boom');
    expect(h.lock.heldKeys.has('gr-ingest')).toBe(false);
  });
});

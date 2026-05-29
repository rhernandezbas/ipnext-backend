import { GestionRealIngestScheduler } from '@infrastructure/scheduling/GestionRealIngestScheduler';
import { IngestGestionRealOrders } from '@application/use-cases/IngestGestionRealOrders';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryGrLinkResolver } from '@infrastructure/adapters/in-memory/InMemoryGrLinkResolver';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryGestionRealIngestConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryProjectRepository } from '@infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';

const DEFAULT_STAGE_ID = '10000000-0000-4000-a000-000000000001';

interface Harness {
  config: InMemoryGestionRealIngestConfigRepository;
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
  const lock = new InMemoryDistributedLock();
  const ingest = new IngestGestionRealOrders(gr, resolver, scheduling, config, state, projects, {
    defaultStageId: DEFAULT_STAGE_ID,
    now: () => new Date('2026-05-29T12:00:00Z'),
  });
  const scheduler = new GestionRealIngestScheduler(ingest, config, { intervalMs: 1000, silent: true }, lock);
  return { config, lock, ingest, scheduler };
}

describe('GestionRealIngestScheduler', () => {
  it('does NOT invoke the ingest when config is disabled (REQ-SCHED-2)', async () => {
    const h = makeHarness();
    await h.config.update({ enabled: false });
    const spy = jest.spyOn(h.ingest, 'execute');

    const summary = await h.scheduler.runOnce();

    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('runs the ingest once when enabled and the lock is free', async () => {
    const h = makeHarness();
    await h.config.update({ enabled: true });
    const spy = jest.spyOn(h.ingest, 'execute');

    const summary = await h.scheduler.runOnce();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(summary.result).toBeDefined();
  });

  it('skips the run when the distributed lock is held by another instance (REQ-SCHED-1)', async () => {
    const h = makeHarness();
    await h.config.update({ enabled: true });
    h.lock.forceAcquireFails = true;
    const spy = jest.spyOn(h.ingest, 'execute');

    const summary = await h.scheduler.runOnce();

    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('does not start a second run while one is in flight (intra-process guard)', async () => {
    const h = makeHarness();
    await h.config.update({ enabled: true });

    const [a, b] = await Promise.all([h.scheduler.runOnce(), h.scheduler.runOnce()]);

    const skipped = [a, b].filter(r => r.skipped).length;
    expect(skipped).toBe(1);
  });

  it('releases the distributed lock after a run (key gr-ingest)', async () => {
    const h = makeHarness();
    await h.config.update({ enabled: true });
    const releaseSpy = jest.spyOn(h.lock, 'release');

    await h.scheduler.runOnce();

    expect(releaseSpy).toHaveBeenCalledWith('gr-ingest');
    expect(h.lock.heldKeys.has('gr-ingest')).toBe(false);
  });

  it('swallows ingest errors so the interval keeps ticking', async () => {
    const h = makeHarness();
    await h.config.update({ enabled: true });
    jest.spyOn(h.ingest, 'execute').mockRejectedValueOnce(new Error('boom'));

    const summary = await h.scheduler.runOnce();

    expect(summary.error).toContain('boom');
    expect(h.lock.heldKeys.has('gr-ingest')).toBe(false);
  });
});

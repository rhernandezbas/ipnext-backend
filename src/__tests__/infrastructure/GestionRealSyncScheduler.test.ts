import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { InMemoryClientMirrorReadRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorReadRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { SyncGestionRealClients } from '@application/use-cases/SyncGestionRealClients';
import { SyncGestionRealContracts } from '@application/use-cases/SyncGestionRealContracts';
import { BackfillGrContractsBatch } from '@application/use-cases/BackfillGrContractsBatch';
import { GestionRealSyncScheduler } from '@infrastructure/scheduling/GestionRealSyncScheduler';
import { GrClient, GrContract } from '@domain/entities/gestionReal';

function client(id: string): GrClient {
  return {
    grClienteId: id, name: `C${id}`, documento: id, email: null, phone: null,
    status: 'Activo', statusCode: '1', address: null, city: null, province: null,
    ultimaModificacion: '27-05-2026 10:00:00', raw: { id },
  };
}
function contract(id: string, cli: string): GrContract {
  return {
    grContratoId: id, grClienteId: cli, plan: '50MB', status: 'Vigente',
    startDate: '01-01-2026', address: null, lat: null, lng: null, pppoeUsername: null, modificado: null, raw: {},
  };
}

function makeScheduler(
  gr: InMemoryGestionRealPort,
  mirror: InMemoryClientMirrorRepository,
  state: InMemorySyncStateRepository,
  lock: InMemoryDistributedLock,
  mirrorRead?: InMemoryClientMirrorReadRepository,
): GestionRealSyncScheduler {
  // Flag ON so the scheduler exercises the real sync path.
  const flags = new InMemoryFeatureFlagRepository();
  flags.seed('gestion-real-sync', true);
  const syncClients = new SyncGestionRealClients(gr, mirror, state, flags);
  const syncContracts = new SyncGestionRealContracts(gr, mirror);
  const backfill = new BackfillGrContractsBatch(
    mirrorRead ?? new InMemoryClientMirrorReadRepository(),
    syncContracts,
    state,
    2,
  );
  return new GestionRealSyncScheduler(syncClients, syncContracts, { intervalMs: 1000, silent: true }, lock, backfill);
}

describe('GestionRealSyncScheduler', () => {
  let gr: InMemoryGestionRealPort;
  let mirror: InMemoryClientMirrorRepository;
  let state: InMemorySyncStateRepository;
  let lock: InMemoryDistributedLock;
  let scheduler: GestionRealSyncScheduler;

  beforeEach(() => {
    gr = new InMemoryGestionRealPort();
    mirror = new InMemoryClientMirrorRepository();
    state = new InMemorySyncStateRepository();
    lock = new InMemoryDistributedLock();
    scheduler = makeScheduler(gr, mirror, state, lock);
  });

  it('runOnce syncs clients and then their contracts', async () => {
    gr.clients = [client('100')];
    gr.contractsByClient = { '100': [contract('k1', '100')] };

    const summary = await scheduler.runOnce();

    expect(mirror.clients.size).toBe(1);
    expect(mirror.contracts.size).toBe(1);
    expect(summary.clients?.created).toBe(1);
    expect(summary.contracts?.created).toBe(1);
  });

  it('in backfill, only fetches contracts for newly-created clients (not re-fetched on re-backfill)', async () => {
    gr.clients = [client('100')];
    gr.contractsByClient = { '100': [contract('k1', '100')] };
    const spy = jest.spyOn(gr, 'fetchContractsByClient');

    await scheduler.runOnce();           // 1st backfill: 100 is created → contracts fetched
    expect(spy).toHaveBeenCalledTimes(1);

    // Force another backfill (clear watermark). 100 already mirrored → created=0 → no contract fetch.
    state.states.clear();
    spy.mockClear();
    await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not start a second run while one is in flight (intra-process lock)', async () => {
    gr.clients = [client('1')];
    // Two concurrent runs — the second must be skipped (intra-process inFlight guard).
    const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    const skipped = [a, b].filter(r => r.skipped).length;
    expect(skipped).toBe(1);
  });

  it('skips sync when distributed lock cannot be acquired (another instance holds it)', async () => {
    gr.clients = [client('42')];
    lock.forceAcquireFails = true;

    const summary = await scheduler.runOnce();

    expect(summary.skipped).toBe(true);
    // syncClients must NOT have been called.
    expect(mirror.clients.size).toBe(0);
  });

  it('releases the distributed lock after a successful run', async () => {
    gr.clients = [client('7')];
    const releaseSpy = jest.spyOn(lock, 'release');

    await scheduler.runOnce();

    expect(releaseSpy).toHaveBeenCalledWith('gr-sync');
    expect(lock.heldKeys.has('gr-sync')).toBe(false);
  });

  it('releases the distributed lock even when the sync throws', async () => {
    jest.spyOn(gr, 'fetchClients').mockRejectedValueOnce(new Error('upstream down'));
    const releaseSpy = jest.spyOn(lock, 'release');

    const summary = await scheduler.runOnce();

    expect(summary.error).toContain('upstream down');
    expect(releaseSpy).toHaveBeenCalledWith('gr-sync');
    expect(lock.heldKeys.has('gr-sync')).toBe(false);
  });

  it('swallows upstream errors so the interval keeps ticking', async () => {
    jest.spyOn(gr, 'fetchClients').mockRejectedValueOnce(new Error('boom'));
    const summary = await scheduler.runOnce();
    expect(summary.error).toContain('boom');
  });

  // ── Contract backfill: one bounded batch per tick (REQ-BACKFILL-SCHED-1) ──

  it('runs exactly one bounded backfill batch per tick when armed (REQ-BACKFILL-SCHED-1)', async () => {
    // Universe of 5 local clients, larger than batchSize (2). No clients in the
    // GR feed → the touched-contracts sync makes no calls; only the backfill does.
    const mirrorRead = new InMemoryClientMirrorReadRepository(['c1', 'c2', 'c3', 'c4', 'c5']);
    gr.contractsByClient = {
      c1: [contract('k1', 'c1')], c2: [contract('k2', 'c2')], c3: [contract('k3', 'c3')],
      c4: [contract('k4', 'c4')], c5: [contract('k5', 'c5')],
    };
    state = new InMemorySyncStateRepository();
    await state.save({ entity: 'gr-contracts-backfill', cursor: '0', lastRunAt: null, lastResult: 'armed', itemsSynced: 0 });
    scheduler = makeScheduler(gr, mirror, state, lock, mirrorRead);
    const spy = jest.spyOn(gr, 'fetchContractsByClient');

    const summary = await scheduler.runOnce();

    // At most batchSize (2) contract calls — NOT the whole 5-client universe.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(summary.backfill?.processed).toBe(2);
    expect(summary.backfill?.done).toBe(false);
    // Lock released — runOnce returned, did not loop to done.
    expect(lock.heldKeys.has('gr-sync')).toBe(false);
  });

  it('runs no backfill batch when disarmed; lock still released (REQ-BACKFILL-SCHED-1)', async () => {
    const mirrorRead = new InMemoryClientMirrorReadRepository(['c1', 'c2', 'c3']);
    gr.contractsByClient = { c1: [contract('k1', 'c1')] };
    // No gr-contracts-backfill row → disarmed.
    scheduler = makeScheduler(gr, mirror, state, lock, mirrorRead);
    const spy = jest.spyOn(gr, 'fetchContractsByClient');

    const summary = await scheduler.runOnce();

    expect(spy).not.toHaveBeenCalled();
    expect(summary.backfill?.processed ?? 0).toBe(0);
    expect(lock.heldKeys.has('gr-sync')).toBe(false);
  });
});

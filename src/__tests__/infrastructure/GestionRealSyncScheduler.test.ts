import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { SyncGestionRealClients } from '@application/use-cases/SyncGestionRealClients';
import { SyncGestionRealContracts } from '@application/use-cases/SyncGestionRealContracts';
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
    startDate: '01-01-2026', address: null, pppoeUsername: null, modificado: null, raw: {},
  };
}

describe('GestionRealSyncScheduler', () => {
  let gr: InMemoryGestionRealPort;
  let mirror: InMemoryClientMirrorRepository;
  let state: InMemorySyncStateRepository;
  let scheduler: GestionRealSyncScheduler;

  beforeEach(() => {
    gr = new InMemoryGestionRealPort();
    mirror = new InMemoryClientMirrorRepository();
    state = new InMemorySyncStateRepository();
    const syncClients = new SyncGestionRealClients(gr, mirror, state);
    const syncContracts = new SyncGestionRealContracts(gr, mirror);
    scheduler = new GestionRealSyncScheduler(syncClients, syncContracts, { intervalMs: 1000, silent: true });
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

  it('does not start a second run while one is in flight (lock)', async () => {
    gr.clients = [client('1')];
    // Two concurrent runs — the second must be skipped.
    const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    const skipped = [a, b].filter(r => r.skipped).length;
    expect(skipped).toBe(1);
  });

  it('swallows upstream errors so the interval keeps ticking', async () => {
    jest.spyOn(gr, 'fetchClients').mockRejectedValueOnce(new Error('boom'));
    const summary = await scheduler.runOnce();
    expect(summary.error).toContain('boom');
  });
});

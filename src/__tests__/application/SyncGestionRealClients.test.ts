import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { SyncGestionRealClients } from '@application/use-cases/SyncGestionRealClients';
import { GrClient } from '@domain/entities/gestionReal';

const SYNC_ENTITY = 'gr-clients';

function makeClient(id: string, mod = '01-01-2026 10:00:00'): GrClient {
  return {
    grClienteId: id,
    name: `Cliente ${id}`,
    documento: id,
    email: `c${id}@mail.com`,
    phone: '123',
    status: 'Activo',
    statusCode: '1',
    address: 'Calle 1',
    city: 'Mercedes',
    province: 'Buenos Aires',
    ultimaModificacion: mod,
    raw: { id },
  };
}

describe('SyncGestionRealClients', () => {
  let gr: InMemoryGestionRealPort;
  let mirror: InMemoryClientMirrorRepository;
  let state: InMemorySyncStateRepository;
  let sync: SyncGestionRealClients;
  const now = new Date(2026, 4, 27, 12, 0, 0); // 27-05-2026

  beforeEach(() => {
    gr = new InMemoryGestionRealPort();
    mirror = new InMemoryClientMirrorRepository();
    state = new InMemorySyncStateRepository();
    sync = new SyncGestionRealClients(gr, mirror, state, { now: () => now, pageSize: 100 });
  });

  it('does a full backfill on the first run (no prior cursor)', async () => {
    gr.clients = [makeClient('1'), makeClient('2'), makeClient('3')];
    const res = await sync.execute();

    expect(res.mode).toBe('backfill');
    expect(res.fetched).toBe(3);
    expect(res.created).toBe(3);
    expect(mirror.clients.size).toBe(3);
    // backfill must NOT send a modification-date filter
    expect(gr.calls.every(c => c.fechaTipo === undefined)).toBe(true);
  });

  it('paginates the backfill using pageSize', async () => {
    gr.clients = Array.from({ length: 250 }, (_, i) => makeClient(String(i + 1)));
    const res = await sync.execute();

    expect(res.fetched).toBe(250);
    expect(mirror.clients.size).toBe(250);
    // 250 / 100 → 3 pages
    expect(gr.calls.map(c => c.offset)).toEqual([0, 100, 200]);
  });

  it('persists the cursor (today) and an ok result after a successful run', async () => {
    gr.clients = [makeClient('1')];
    await sync.execute();
    const saved = await state.get(SYNC_ENTITY);

    expect(saved?.cursor).toBe('27-05-2026');
    expect(saved?.lastResult).toBe('ok');
    expect(saved?.itemsSynced).toBe(1);
    expect(saved?.lastRunAt).toEqual(now);
  });

  it('runs in delta mode when a cursor already exists, filtering by modification date', async () => {
    await state.save({ entity: SYNC_ENTITY, cursor: '20-05-2026', lastRunAt: null, lastResult: 'ok', itemsSynced: 0 });
    gr.clients = [
      makeClient('1', '10-05-2026 10:00:00'), // before cursor → excluded by the delta filter
      makeClient('2', '25-05-2026 10:00:00'), // after cursor  → included
    ];
    const res = await sync.execute();

    expect(res.mode).toBe('delta');
    expect(gr.calls[0].fechaTipo).toBe('m');
    expect(gr.calls[0].fechaDesde).toBe('20-05-2026');
    expect(res.fetched).toBe(1);
    expect(mirror.clients.has('2')).toBe(true);
    expect(mirror.clients.has('1')).toBe(false);
  });

  it('counts updates separately from creates (idempotent upsert)', async () => {
    // Modified on the run date so it stays inside the delta window on the 2nd pass.
    gr.clients = [makeClient('1', '27-05-2026 09:00:00')];
    await sync.execute(); // created
    const res = await sync.execute(); // same client again → updated

    expect(res.created).toBe(0);
    expect(res.updated).toBe(1);
    expect(mirror.clients.size).toBe(1);
  });

  it('records an error result and rethrows when the upstream fails', async () => {
    jest.spyOn(gr, 'fetchClients').mockRejectedValueOnce(new Error('GR down'));
    await expect(sync.execute()).rejects.toThrow('GR down');

    const saved = await state.get(SYNC_ENTITY);
    expect(saved?.lastResult).toContain('error');
  });
});

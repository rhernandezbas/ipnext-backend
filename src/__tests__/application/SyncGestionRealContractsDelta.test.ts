import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { SyncGestionRealContractsDelta } from '@application/use-cases/SyncGestionRealContractsDelta';
import { GrClient, GrContract } from '@domain/entities/gestionReal';

const SYNC_ENTITY = 'gr-contracts-delta';
const SYNC_FLAG_KEY = 'gestion-real-sync';

function makeClient(id: string): GrClient {
  return {
    grClienteId: id, name: `Cliente ${id}`, documento: id, email: null, phone: null,
    status: 'Activo', statusCode: '1', address: null, city: null, province: null,
    ultimaModificacion: '20-06-2026 10:00:00', fechaCreacion: null, raw: {},
  };
}

function makeContract(id: string, cli: string, modificado: string | null = '20-06-2026 10:00:00'): GrContract {
  return {
    grContratoId: id,
    grClienteId: cli,
    plan: 'IP-Air-30',
    status: 'Vigente',
    startDate: '01-01-2025',
    address: null,
    lat: null,
    lng: null,
    pppoeUsername: null,
    modificado,
    fechaCreacion: null,
    vendedor: null,
    motivoBaja: null,
    raw: {},
  };
}

describe('SyncGestionRealContractsDelta', () => {
  let gr: InMemoryGestionRealPort;
  let mirror: InMemoryClientMirrorRepository;
  let state: InMemorySyncStateRepository;
  let flags: InMemoryFeatureFlagRepository;
  let sync: SyncGestionRealContractsDelta;
  // Fixed "today" = 30-06-2026
  const now = new Date(2026, 5, 30, 12, 0, 0);

  beforeEach(() => {
    gr = new InMemoryGestionRealPort();
    mirror = new InMemoryClientMirrorRepository();
    mirror.enforceParent = true;
    state = new InMemorySyncStateRepository();
    flags = new InMemoryFeatureFlagRepository();
    flags.seed(SYNC_FLAG_KEY, true);
    sync = new SyncGestionRealContractsDelta(gr, mirror, state, flags, { now: () => now, pageSize: 100 });
  });

  // T1 — REQ-DELTA-3: contract modified without client change → mirrored
  it('T1: contrato modificado, cliente sin cambios → upsertContract llamado y contrato espejado', async () => {
    // Client '111' is already mirrored
    mirror.clients.set('111', makeClient('111'));
    // Contract '900' modified inside today's window
    gr.contractsModified = [makeContract('900', '111', '30-06-2026 09:00:00')];

    const result = await sync.execute();

    expect(mirror.contracts.has('900')).toBe(true);
    expect(mirror.contracts.get('900')?.grClienteId).toBe('111');
    expect(result.fetched).toBe(1);
    expect(result.created).toBe(1);
  });

  // T2 — REQ-DELTA-4: titularidad — new client already mirrored + new contract
  it('T2: titularidad — contrato nuevo cuelga del cliente nuevo ya espejado', async () => {
    // Client '222' was mirrored by the client-sync in this tick
    mirror.clients.set('222', makeClient('222'));
    gr.contractsModified = [makeContract('901', '222', '30-06-2026 10:00:00')];

    const result = await sync.execute();

    expect(mirror.contracts.has('901')).toBe(true);
    expect(mirror.contracts.get('901')?.grClienteId).toBe('222');
    expect(result.created).toBe(1);
  });

  // T3 — REQ-DELTA-5: client not yet mirrored → skip without crash, process rest
  it('T3: cliente dueño inexistente → skip sin crash, procesa el resto', async () => {
    // Client '111' exists, '999' does not
    mirror.clients.set('111', makeClient('111'));
    gr.contractsModified = [
      makeContract('950', '999', '30-06-2026 09:00:00'),  // '999' not in mirror → skip
      makeContract('900', '111', '30-06-2026 10:00:00'),  // '111' exists → process
    ];

    const result = await sync.execute();

    // '950' not created (orphan guard)
    expect(mirror.contracts.has('950')).toBe(false);
    // '900' processed normally
    expect(mirror.contracts.has('900')).toBe(true);
    // no crash, result reflects what was processed
    expect(result.fetched).toBe(2);
  });

  // T3b — REQ-DELTA-5: recovery — same-day scenario (honest: no cursor rewind)
  it('T3b: recuperación same-day — cliente espejado en el mismo día → contrato procesado en el siguiente tick', async () => {
    // tick 1: client '999' absent → contract skipped (orphan guard)
    gr.contractsModified = [makeContract('950', '999', '30-06-2026 09:00:00')];
    const r1 = await sync.execute();
    expect(mirror.contracts.has('950')).toBe(false);
    // FIX 2: orphan must count as skipped, not as updated
    expect(r1.skipped).toBe(1);

    // Same day: client-sync mirrors '999' (cursor is now '30-06-2026', NOT rewound)
    mirror.clients.set('999', makeClient('999'));

    // tick 2: fechaDesde = cursor = '30-06-2026', fechaHasta = '30-06-2026' (same runDate)
    // Contract modificado='30-06-2026 09:00:00' is still within the same-day overlap window.
    const r2 = await sync.execute();

    expect(mirror.contracts.has('950')).toBe(true);
    expect(r2.created).toBe(1);
    // NOTE: same-day overlap recovery is by design — the cursor re-scans from the last
    // cursor date and upserts are idempotent (same pattern as SyncGestionRealClients).
    // Cross-day recovery (client appears after cursor advanced past the contract's
    // modificado date) is best-effort, bounded by the overlap, and residually covered
    // by the backfill. The backfill is the safety net for that edge case.
  });

  // T4 — REQ-DELTA-2: pagination — 3 contracts / pageSize 2 → 2 m-scan calls + 1 c-scan call
  it('T4: paginación 3 contratos / pageSize 2 → m-scan: 2 pages, c-scan: 1 page, 3 procesados una sola vez', async () => {
    mirror.clients.set('111', makeClient('111'));
    mirror.clients.set('222', makeClient('222'));
    mirror.clients.set('333', makeClient('333'));
    gr.contractsModified = [
      makeContract('c1', '111', '30-06-2026 09:00:00'),
      makeContract('c2', '222', '30-06-2026 09:30:00'),
      makeContract('c3', '333', '30-06-2026 10:00:00'),
    ];
    sync = new SyncGestionRealContractsDelta(gr, mirror, state, flags, { now: () => now, pageSize: 2 });

    const result = await sync.execute();

    // m-scan: 3 contracts, pageSize 2 → 2 paginated calls (offsets 0, 2)
    const mCalls = gr.contractsDeltaCalls.filter(c => c.fechaTipo === 'm');
    expect(mCalls).toHaveLength(2);
    expect(mCalls[0].offset).toBe(0);
    expect(mCalls[1].offset).toBe(2);
    // c-scan: no contracts with fechaCreacion → 1 call returns empty
    const cCalls = gr.contractsDeltaCalls.filter(c => c.fechaTipo === 'c');
    expect(cCalls).toHaveLength(1);
    // all 3 processed exactly once (deduped)
    expect(result.fetched).toBe(3);
    expect(result.created).toBe(3);
  });

  // T5 — REQ-DELTA-6: first run without cursor → window = today, persists today
  it('T5: primer run sin cursor → ventana [hoy, hoy], persiste cursor = hoy', async () => {
    gr.contractsModified = [];  // empty feed is fine for this test

    await sync.execute();

    const calls = gr.contractsDeltaCalls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].fechaDesde).toBe('30-06-2026');
    expect(calls[0].fechaHasta).toBe('30-06-2026');

    const saved = await state.get(SYNC_ENTITY);
    expect(saved?.cursor).toBe('30-06-2026');
    expect(saved?.lastResult).toBe('ok');
  });

  // T6 — REQ-DELTA-7: next run with cursor → fechaDesde = prior cursor, fechaHasta = today
  it('T6: run siguiente con cursor → fechaDesde = cursor previo, cursor avanza a hoy', async () => {
    await state.save({ entity: SYNC_ENTITY, cursor: '28-06-2026', lastRunAt: new Date(2026, 5, 28), lastResult: 'ok', itemsSynced: 0 });
    gr.contractsModified = [];

    await sync.execute();

    const calls = gr.contractsDeltaCalls;
    expect(calls[0].fechaDesde).toBe('28-06-2026');
    expect(calls[0].fechaHasta).toBe('30-06-2026');

    const saved = await state.get(SYNC_ENTITY);
    expect(saved?.cursor).toBe('30-06-2026');
  });

  // T7 — REQ-DELTA-8: idempotency — re-running same day → update, not second row
  it('T7: idempotencia — re-correr mismo día → update, no segundo row', async () => {
    mirror.clients.set('111', makeClient('111'));
    gr.contractsModified = [makeContract('900', '111', '30-06-2026 09:00:00')];

    const res1 = await sync.execute();
    expect(res1.created).toBe(1);
    expect(mirror.contracts.size).toBe(1);

    // Second run same day — cursor is today so fechaDesde = today again
    const res2 = await sync.execute();
    expect(res2.created).toBe(0);
    expect(res2.updated).toBe(1);
    expect(mirror.contracts.size).toBe(1);
  });

  // T8 — REQ-DELTA-9: flag OFF → no-op
  it('T8: flag gestion-real-sync OFF → no-op (sin call GR, sin tocar SyncState)', async () => {
    flags.seed(SYNC_FLAG_KEY, false);
    gr.contractsModified = [makeContract('900', '111', '30-06-2026 09:00:00')];

    const result = await sync.execute();

    expect(gr.contractsDeltaCalls).toHaveLength(0);
    expect(await state.get(SYNC_ENTITY)).toBeNull();
    expect(mirror.contracts.size).toBe(0);
    expect(result.skippedFlag).toBe(true);
    expect(result.fetched).toBe(0);
  });

  // T9 — error in GR → persists error state with prior cursor, rethrows
  it('T9: error en GR → persiste estado error con cursor previo, re-lanza', async () => {
    await state.save({ entity: SYNC_ENTITY, cursor: '28-06-2026', lastRunAt: new Date(2026, 5, 28), lastResult: 'ok', itemsSynced: 0 });
    jest.spyOn(gr, 'fetchContractsModifiedSince').mockRejectedValueOnce(new Error('GR down'));

    await expect(sync.execute()).rejects.toThrow('GR down');

    const saved = await state.get(SYNC_ENTITY);
    expect(saved?.lastResult).toContain('error');
    expect(saved?.cursor).toBe('28-06-2026'); // prior cursor preserved
  });

  // ── FIX 2: skipped counter ───────────────────────────────────────────────

  // T_fix2 — REQ-DELTA-5: orphan contract counts as skipped, not updated
  it('T_fix2: contrato huérfano (dueño inexistente) → result.skipped++, updated NO cambia', async () => {
    // No client in mirror — enforceParent=true (set in beforeEach)
    gr.contractsModified = [makeContract('950', '999', '30-06-2026 09:00:00')];

    const result = await sync.execute();

    expect(result.skipped).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.created).toBe(0);
    expect(result.fetched).toBe(1);
  });

  // ── FIX 1: c-scan (fecha_tipo=c) finds contracts created without modificado ──

  // T_c1 — GR does not set modificado on new contracts; c-scan fills the gap
  it('T_c1: contrato creado sin modificado (null) → m-scan lo PIERDE, c-scan lo ENCUENTRA', async () => {
    await state.save({ entity: SYNC_ENTITY, cursor: '28-06-2026', lastRunAt: new Date(2026, 5, 28), lastResult: 'ok', itemsSynced: 0 });
    mirror.clients.set('444', makeClient('444'));
    // Real-world case verified with GR: contracts IDs 12116, 12144, 12148 — created
    // without modificado → invisible to fecha_tipo=m delta alone.
    gr.contractsModified = [{
      ...makeContract('800', '444', null),  // modificado=null → m-scan misses it
      fechaCreacion: '29-06-2026 08:00:00',
    }];

    const result = await sync.execute();

    expect(mirror.contracts.has('800')).toBe(true);
    expect(result.created).toBe(1);
    expect(result.fetched).toBe(1);
  });

  // T_c2 — contract in BOTH scans → processed exactly once (dedup by grContratoId)
  it('T_c2: contrato en m-scan Y c-scan → dedup → procesado UNA sola vez', async () => {
    await state.save({ entity: SYNC_ENTITY, cursor: '28-06-2026', lastRunAt: new Date(2026, 5, 28), lastResult: 'ok', itemsSynced: 0 });
    mirror.clients.set('555', makeClient('555'));
    // Contract has BOTH modificado and fechaCreacion in window → both scans return it
    gr.contractsModified = [{
      ...makeContract('810', '555', '29-06-2026 10:00:00'),
      fechaCreacion: '29-06-2026 08:00:00',
    }];

    const result = await sync.execute();

    expect(mirror.contracts.has('810')).toBe(true);
    // dedup: created exactly once, not twice
    expect(result.created).toBe(1);
    expect(result.fetched).toBe(1);
  });

  // T_c3 — adapter receives fechaTipo='m' for m-scan and fechaTipo='c' for c-scan
  it('T_c3: el use case pasa fechaTipo correcto en cada scan (m y c)', async () => {
    gr.contractsModified = [];

    await sync.execute();

    const fechaTiposSent = gr.contractsDeltaCalls.map(c => c.fechaTipo);
    expect(fechaTiposSent).toContain('m');
    expect(fechaTiposSent).toContain('c');
  });
});

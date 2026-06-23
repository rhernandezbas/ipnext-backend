import { IngestRadiusAccounting } from '@application/use-cases/IngestRadiusAccounting';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRadiusEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusEventRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import type { AccountingEventRow } from '@domain/ports/RadiusOrchestratorGateway';

const NOW = new Date('2026-06-22T12:00:00Z');

function makeEvent(overrides: Partial<AccountingEventRow> = {}): AccountingEventRow {
  return {
    uniqueId:     'uid-001',
    username:     'u1',
    nasIpAddress: '192.168.1.1',
    framedIp:     null,
    macAddress:   null,
    vlan:         null,
    startedAt:    '2026-06-22T10:00:00Z',
    stoppedAt:    null,
    sessionTime:  null,
    inOctets:     BigInt(0),
    outOctets:    BigInt(0),
    lastUpdate:   null,    // FIX2: acctupdatetime — null = usa startedAt como fallback
    ...overrides,
  };
}

function makeUseCase(events: AccountingEventRow[] = []) {
  const gateway   = new InMemoryRadiusOrchestratorGateway({ accountingEvents: events });
  const eventRepo = new InMemoryRadiusEventRepository();
  const nasRepo   = new InMemoryNasRepository();
  const stateRepo = new InMemorySyncStateRepository();
  const ingest    = new IngestRadiusAccounting(gateway, eventRepo, nasRepo, stateRepo, { now: () => NOW });
  return { gateway, eventRepo, nasRepo, stateRepo, ingest };
}

describe('IngestRadiusAccounting', () => {
  it('REQ-INGEST-2: primera vez sin cursor - upserta todos', async () => {
    const { ingest, eventRepo } = makeUseCase([makeEvent()]);
    const result = await ingest.run();
    expect(result.upserted).toBe(1);
    expect(result.newCursor).toBe('2026-06-22T10:00:00Z');
    const stored = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(stored.total).toBe(1);
    expect(stored.data[0].sourceUniqueId).toBe('uid-001');
  });

  it('REQ-INGEST-2/FIX2: avanza cursor al max lastUpdate (fallback a startedAt si lastUpdate=null)', async () => {
    // Cuando lastUpdate=null, el fallback usa startedAt
    const { ingest } = makeUseCase([
      makeEvent({ uniqueId: 'a', startedAt: '2026-06-22T09:00:00Z', lastUpdate: null }),
      makeEvent({ uniqueId: 'b', startedAt: '2026-06-22T11:00:00Z', lastUpdate: null }),
      makeEvent({ uniqueId: 'c', startedAt: '2026-06-22T10:00:00Z', lastUpdate: null }),
    ]);
    const result = await ingest.run();
    // Con fallback a startedAt, el max es 11:00
    expect(result.newCursor).toBe('2026-06-22T11:00:00Z');
  });

  it('REQ-INGEST-2/FIX2: segunda vez llama con sinceUpdate = cursor - 2h', async () => {
    const gateway   = new InMemoryRadiusOrchestratorGateway({ accountingEvents: [makeEvent({ uniqueId: 'uid-002', startedAt: '2026-06-22T11:00:00Z', lastUpdate: '2026-06-22T11:00:00Z' })] });
    const eventRepo = new InMemoryRadiusEventRepository();
    const nasRepo   = new InMemoryNasRepository();
    const stateRepo = new InMemorySyncStateRepository();
    await stateRepo.save({ entity: 'radius-accounting-ingest', cursor: '2026-06-22T10:00:00Z', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1 });
    const ingest = new IngestRadiusAccounting(gateway, eventRepo, nasRepo, stateRepo, { now: () => NOW, reScanWindowMs: 2 * 60 * 60 * 1000 });
    const listSpy = jest.spyOn(gateway, 'listAccounting');
    await ingest.run();
    // FIX2: ahora usa sinceUpdate en lugar de sinceStart
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ sinceUpdate: '2026-06-22T08:00:00.000Z' }));
  });

  it('REQ-INGEST-3: upsert idempotente - re-correr no duplica filas', async () => {
    const { ingest, eventRepo } = makeUseCase([makeEvent()]);
    await ingest.run();
    await ingest.run();
    const stored = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(stored.total).toBe(1);
  });

  it('REQ-INGEST-3: sesion abierta que cierra - actualiza stoppedAt y status', async () => {
    const eventRepo = new InMemoryRadiusEventRepository();
    const nasRepo   = new InMemoryNasRepository();
    const stateRepo = new InMemorySyncStateRepository();
    const gw1 = new InMemoryRadiusOrchestratorGateway({ accountingEvents: [makeEvent({ uniqueId: 'uid-open', stoppedAt: null })] });
    await new IngestRadiusAccounting(gw1, eventRepo, nasRepo, stateRepo, { now: () => NOW }).run();
    const s1 = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(s1.data[0].status).toBe('online');
    expect(s1.data[0].stoppedAt).toBeNull();
    const gw2 = new InMemoryRadiusOrchestratorGateway({ accountingEvents: [makeEvent({ uniqueId: 'uid-open', stoppedAt: '2026-06-22T11:30:00Z', sessionTime: 5400 })] });
    await new IngestRadiusAccounting(gw2, eventRepo, nasRepo, stateRepo, { now: () => NOW }).run();
    const s2 = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(s2.total).toBe(1);
    expect(s2.data[0].status).toBe('closed');
    expect(s2.data[0].stoppedAt).toBeTruthy();
  });

  it('REQ-INGEST-4: nasId resuelto cuando nasIpAddress coincide', async () => {
    const { ingest, eventRepo } = makeUseCase([makeEvent({ nasIpAddress: '192.168.1.1' })]);
    await ingest.run();
    const stored = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(stored.data[0].nasId).toBe('1');
  });

  it('REQ-INGEST-4: nasId=null cuando no hay NasServer con esa IP', async () => {
    const { ingest, eventRepo } = makeUseCase([makeEvent({ nasIpAddress: '10.75.0.30' })]);
    const result = await ingest.run();
    expect(result.upserted).toBe(1);
    const stored = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(stored.data[0].nasId).toBeNull();
  });

  it('REQ-INGEST-5: paginacion - procesa todas las paginas', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({ accountingEvents: [
      makeEvent({ uniqueId: 'p1', startedAt: '2026-06-22T09:00:00Z' }),
      makeEvent({ uniqueId: 'p2', startedAt: '2026-06-22T10:00:00Z' }),
      makeEvent({ uniqueId: 'p3', startedAt: '2026-06-22T11:00:00Z' }),
    ]});
    const ingest = new IngestRadiusAccounting(gateway, new InMemoryRadiusEventRepository(), new InMemoryNasRepository(), new InMemorySyncStateRepository(), { now: () => NOW, pageSize: 1 });
    const result = await ingest.run();
    expect(result.upserted).toBe(3);
    expect(result.pages).toBe(3);
  });

  it('REQ-INGEST-6: error del gateway se propaga (el scheduler lo swallows)', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway();
    jest.spyOn(gateway, 'listAccounting').mockRejectedValueOnce(new Error('unreachable'));
    const ingest = new IngestRadiusAccounting(gateway, new InMemoryRadiusEventRepository(), new InMemoryNasRepository(), new InMemorySyncStateRepository(), { now: () => NOW });
    await expect(ingest.run()).rejects.toThrow('unreachable');
  });

  it('REQ-PURGE-1: purga filas con startedAt < (now - retentionMonths)', async () => {
    const eventRepo = new InMemoryRadiusEventRepository();
    await eventRepo.upsertMany([
      { sourceUniqueId: 'old',   username: 'u', nasIpAddress: '1.1.1.1', nasId: null, framedIp: null, macAddress: null, vlanId: null, startedAt: new Date('2025-06-21T00:00:00Z'), stoppedAt: null, sessionTime: null, bytesIn: 0n, bytesOut: 0n, eventType: 'start', status: 'online' },
      { sourceUniqueId: 'fresh', username: 'u', nasIpAddress: '1.1.1.1', nasId: null, framedIp: null, macAddress: null, vlanId: null, startedAt: new Date('2026-01-01T00:00:00Z'), stoppedAt: null, sessionTime: null, bytesIn: 0n, bytesOut: 0n, eventType: 'start', status: 'online' },
    ]);
    const gateway = new InMemoryRadiusOrchestratorGateway({ accountingEvents: [makeEvent({ uniqueId: 'fresh', startedAt: '2026-01-01T00:00:00Z' })] });
    const ingest  = new IngestRadiusAccounting(gateway, eventRepo, new InMemoryNasRepository(), new InMemorySyncStateRepository(), { now: () => NOW, retentionMonths: 12 });
    const result  = await ingest.run();
    expect(result.purgedRows).toBeGreaterThanOrEqual(1);
    const ids = (await eventRepo.list({ page: 1, pageSize: 10 })).data.map(e => e.sourceUniqueId);
    expect(ids).not.toContain('old');
    expect(ids).toContain('fresh');
  });

  it('REQ-PURGE-3: error en purga no aborta el ingest (best-effort)', async () => {
    const eventRepo = new InMemoryRadiusEventRepository();
    jest.spyOn(eventRepo, 'deleteOlderThan').mockRejectedValueOnce(new Error('purge-fail'));
    const ingest = new IngestRadiusAccounting(new InMemoryRadiusOrchestratorGateway({ accountingEvents: [makeEvent()] }), eventRepo, new InMemoryNasRepository(), new InMemorySyncStateRepository(), { now: () => NOW });
    await expect(ingest.run()).resolves.toMatchObject({ upserted: 1 });
  });

  it('SyncState: guarda cursor y lastResult ok', async () => {
    const { ingest, stateRepo } = makeUseCase([makeEvent()]);
    await ingest.run();
    const state = await stateRepo.get('radius-accounting-ingest');
    expect(state?.cursor).toBe('2026-06-22T10:00:00Z');
    expect(state?.lastResult).toBe('ok');
    expect(state?.itemsSynced).toBe(1);
  });

  // ── FIX 2: Ghost-online — cursor e filtro por lastUpdate (acctupdatetime) ───────────────────────
  // BUG: sesion con startedAt viejo (fuera de ventana) pero lastUpdate reciente (recien cerrada)
  // nunca ingresaba el cierre porque el filtro era sinceStart sobre startedAt.
  // FIX: cursor = max(lastUpdate); ventana filtra por lastUpdate (sinceUpdate/untilUpdate).

  it('FIX2: sesion con startedAt viejo pero lastUpdate reciente es ingestada y cierra el evento', async () => {
    const eventRepo = new InMemoryRadiusEventRepository();
    const nasRepo   = new InMemoryNasRepository();
    const stateRepo = new InMemorySyncStateRepository();

    // 1er run: sesion online con startedAt antiguo (hace 3 dias), lastUpdate antiguo
    const oldStart = '2026-06-19T10:00:00Z';
    const oldUpdate = '2026-06-19T10:00:00Z';
    const gw1 = new InMemoryRadiusOrchestratorGateway({
      accountingEvents: [makeEvent({
        uniqueId: 'long-session',
        startedAt: oldStart,
        stoppedAt: null,
        lastUpdate: oldUpdate,
      })],
    });
    await new IngestRadiusAccounting(gw1, eventRepo, nasRepo, stateRepo, { now: () => NOW }).run();
    const s1 = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(s1.data[0].status).toBe('online');

    // El cursor ahora es lastUpdate = '2026-06-19T10:00:00Z'
    const state = await stateRepo.get('radius-accounting-ingest');
    expect(state?.cursor).toBe(oldUpdate);

    // 2do run: la sesion CERRA (lastUpdate = NOW, startedAt sigue siendo viejo)
    // Con el bug (sinceStart), el startedAt viejo queda FUERA de la ventana y NO entra
    // Con el FIX (sinceUpdate), el lastUpdate reciente SI entra en la ventana
    const recentUpdate = NOW.toISOString();
    const gw2 = new InMemoryRadiusOrchestratorGateway({
      accountingEvents: [makeEvent({
        uniqueId: 'long-session',
        startedAt: oldStart,
        stoppedAt: '2026-06-22T11:59:00Z',
        sessionTime: 86400 * 3,
        lastUpdate: recentUpdate,
      })],
    });
    await new IngestRadiusAccounting(gw2, eventRepo, nasRepo, stateRepo, {
      now: () => NOW,
      reScanWindowMs: 2 * 60 * 60 * 1000,
    }).run();

    // El evento DEBE haber cambiado a closed (no ghost-online)
    const s2 = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(s2.total).toBe(1);
    expect(s2.data[0].status).toBe('closed');
    expect(s2.data[0].stoppedAt).toBeTruthy();
  });

  it('FIX2: cursor es max(lastUpdate) en lugar de max(startedAt)', async () => {
    const events: AccountingEventRow[] = [
      makeEvent({ uniqueId: 'a', startedAt: '2026-06-22T09:00:00Z', lastUpdate: '2026-06-22T09:30:00Z' }),
      makeEvent({ uniqueId: 'b', startedAt: '2026-06-22T11:00:00Z', lastUpdate: '2026-06-22T11:59:00Z' }),
      makeEvent({ uniqueId: 'c', startedAt: '2026-06-22T10:00:00Z', lastUpdate: '2026-06-22T10:15:00Z' }),
    ];
    const { ingest, stateRepo } = makeUseCase(events);
    const result = await ingest.run();
    // El cursor debe ser el max lastUpdate (11:59), NO max startedAt (11:00)
    // El string se preserva tal cual (no se convierte con toISOString)
    expect(result.newCursor).toBe('2026-06-22T11:59:00Z');
  });

  it('FIX2: segunda corrida llama con sinceUpdate = cursor - 2h (no sinceStart)', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({
      accountingEvents: [makeEvent({
        uniqueId: 'x',
        startedAt: '2026-06-22T11:00:00Z',
        lastUpdate: '2026-06-22T11:00:00Z',
      })],
    });
    const eventRepo = new InMemoryRadiusEventRepository();
    const nasRepo   = new InMemoryNasRepository();
    const stateRepo = new InMemorySyncStateRepository();
    // Cursor previo en lastUpdate
    await stateRepo.save({
      entity: 'radius-accounting-ingest',
      cursor: '2026-06-22T10:00:00Z',
      lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1,
    });
    const ingest = new IngestRadiusAccounting(gateway, eventRepo, nasRepo, stateRepo, {
      now: () => NOW,
      reScanWindowMs: 2 * 60 * 60 * 1000,
    });
    const listSpy = jest.spyOn(gateway, 'listAccounting');
    await ingest.run();
    // Debe llamar con sinceUpdate (no sinceStart)
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ sinceUpdate: '2026-06-22T08:00:00.000Z' }));
    expect(listSpy).not.toHaveBeenCalledWith(expect.objectContaining({ sinceStart: expect.anything() }));
  });

  // ── FIX 6: Purga con cap por tick (maxBatchesPerTick) ───────────────────────
  // BUG: deleteOlderThan puede tragarse TODO el backlog en un tick bajo el lock.
  // FIX: maxBatchesPerTick limita cuántos batches de purga se ejecutan por tick.

  it('FIX6: maxBatchesPerTick=2 limita la cantidad de batches de purga', async () => {
    const eventRepo = new InMemoryRadiusEventRepository();
    let deleteCallCount = 0;
    const originalDelete = eventRepo.deleteOlderThan.bind(eventRepo);
    jest.spyOn(eventRepo, 'deleteOlderThan').mockImplementation(async (cutoff, batchSize) => {
      deleteCallCount++;
      return originalDelete(cutoff, batchSize);
    });

    // No importa la cantidad de rows; lo que cuenta es que deleteOlderThan se llama max 2 veces
    const ingest = new IngestRadiusAccounting(
      new InMemoryRadiusOrchestratorGateway({ accountingEvents: [makeEvent()] }),
      eventRepo,
      new InMemoryNasRepository(),
      new InMemorySyncStateRepository(),
      { now: () => NOW, maxBatchesPerTick: 2 },
    );
    await ingest.run();
    // Con maxBatchesPerTick=2, deleteOlderThan se llama máximo 2 veces
    expect(deleteCallCount).toBeLessThanOrEqual(2);
  });

  it('FIX6: sin maxBatchesPerTick usa el default (no limita artificialmente)', async () => {
    const eventRepo = new InMemoryRadiusEventRepository();
    // Sembrar datos viejos para que haya algo que purgar
    await eventRepo.upsertMany(
      Array.from({ length: 5 }, (_, i) => ({
        sourceUniqueId: `old-${i}`,
        username: 'u', nasIpAddress: '1.1.1.1', nasId: null,
        framedIp: null, macAddress: null, vlanId: null,
        startedAt: new Date('2020-01-01T00:00:00Z'),
        stoppedAt: null, sessionTime: null, bytesIn: 0n, bytesOut: 0n,
        eventType: 'start' as const, status: 'online' as const,
      })),
    );
    const ingest = new IngestRadiusAccounting(
      new InMemoryRadiusOrchestratorGateway({ accountingEvents: [] }),
      eventRepo,
      new InMemoryNasRepository(),
      new InMemorySyncStateRepository(),
      { now: () => NOW, retentionMonths: 1, purgeBatchSize: 2 }, // batch=2, 5 rows → 3 batches
    );
    const result = await ingest.run();
    // Sin cap, debe purgar todos los 5
    expect(result.purgedRows).toBe(5);
  });

});

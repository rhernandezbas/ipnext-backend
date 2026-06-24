import { IngestRadiusAuth } from '@application/use-cases/IngestRadiusAuth';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRadiusAuthEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusAuthEventRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import type { AuthEventRow } from '@domain/ports/RadiusOrchestratorGateway';

const NOW = new Date('2026-06-22T12:00:00Z');

function makeEvent(overrides: Partial<AuthEventRow> = {}): AuthEventRow {
  return {
    sourceId: 'pa-001',
    username: 'u1',
    reply:    'Access-Reject',
    authdate: '2026-06-22T10:00:00Z',
    class:    null,
    ...overrides,
  };
}

function makeUseCase(events: AuthEventRow[] = []) {
  const gateway   = new InMemoryRadiusOrchestratorGateway({ authEvents: events });
  const eventRepo = new InMemoryRadiusAuthEventRepository();
  const stateRepo = new InMemorySyncStateRepository();
  const ingest    = new IngestRadiusAuth(gateway, eventRepo, stateRepo, { now: () => NOW });
  return { gateway, eventRepo, stateRepo, ingest };
}

describe('IngestRadiusAuth', () => {
  it('primera vez sin cursor - upserta todos', async () => {
    const { ingest, eventRepo } = makeUseCase([makeEvent()]);
    const result = await ingest.run();
    expect(result.upserted).toBe(1);
    expect(result.newCursor).toBe('2026-06-22T10:00:00Z');
    const stored = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(stored.total).toBe(1);
    expect(stored.data[0].username).toBe('u1');
    expect(stored.data[0].reply).toBe('Access-Reject');
  });

  it('avanza cursor al max authdate', async () => {
    const { ingest } = makeUseCase([
      makeEvent({ sourceId: 'a', authdate: '2026-06-22T09:00:00Z' }),
      makeEvent({ sourceId: 'b', authdate: '2026-06-22T11:00:00Z' }),
      makeEvent({ sourceId: 'c', authdate: '2026-06-22T10:00:00Z' }),
    ]);
    const result = await ingest.run();
    expect(result.newCursor).toBe('2026-06-22T11:00:00Z');
  });

  it('segunda vez llama con sinceAuthdate = cursor - 2h', async () => {
    const gateway   = new InMemoryRadiusOrchestratorGateway({ authEvents: [makeEvent({ sourceId: 'pa-002', authdate: '2026-06-22T11:00:00Z' })] });
    const eventRepo = new InMemoryRadiusAuthEventRepository();
    const stateRepo = new InMemorySyncStateRepository();
    await stateRepo.save({ entity: 'radius-auth-ingest', cursor: '2026-06-22T10:00:00Z', lastRunAt: new Date(), lastResult: 'ok', itemsSynced: 1 });
    const ingest = new IngestRadiusAuth(gateway, eventRepo, stateRepo, { now: () => NOW, reScanWindowMs: 2 * 60 * 60 * 1000 });
    const listSpy = jest.spyOn(gateway, 'listPostauth');
    await ingest.run();
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ sinceAuthdate: '2026-06-22T08:00:00.000Z' }));
  });

  it('upsert idempotente - re-correr no duplica filas', async () => {
    const { ingest, eventRepo } = makeUseCase([makeEvent()]);
    await ingest.run();
    await ingest.run();
    const stored = await eventRepo.list({ page: 1, pageSize: 10 });
    expect(stored.total).toBe(1);
  });

  it('paginacion - procesa todas las paginas', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway({ authEvents: [
      makeEvent({ sourceId: 'p1', authdate: '2026-06-22T09:00:00Z' }),
      makeEvent({ sourceId: 'p2', authdate: '2026-06-22T10:00:00Z' }),
      makeEvent({ sourceId: 'p3', authdate: '2026-06-22T11:00:00Z' }),
    ]});
    const ingest = new IngestRadiusAuth(gateway, new InMemoryRadiusAuthEventRepository(), new InMemorySyncStateRepository(), { now: () => NOW, pageSize: 1 });
    const result = await ingest.run();
    expect(result.upserted).toBe(3);
    expect(result.pages).toBe(3);
  });

  it('error del gateway se propaga (el scheduler lo swallows)', async () => {
    const gateway = new InMemoryRadiusOrchestratorGateway();
    jest.spyOn(gateway, 'listPostauth').mockRejectedValueOnce(new Error('unreachable'));
    const ingest = new IngestRadiusAuth(gateway, new InMemoryRadiusAuthEventRepository(), new InMemorySyncStateRepository(), { now: () => NOW });
    await expect(ingest.run()).rejects.toThrow('unreachable');
  });

  it('purga filas con authdate < (now - retentionMonths)', async () => {
    const eventRepo = new InMemoryRadiusAuthEventRepository();
    await eventRepo.upsertMany([
      { sourceUniqueId: 'old',   username: 'u', reply: 'Access-Reject', authdate: new Date('2025-06-21T00:00:00Z'), class: null },
      { sourceUniqueId: 'fresh', username: 'u', reply: 'Access-Reject', authdate: new Date('2026-01-01T00:00:00Z'), class: null },
    ]);
    const gateway = new InMemoryRadiusOrchestratorGateway({ authEvents: [makeEvent({ sourceId: 'fresh', authdate: '2026-01-01T00:00:00Z' })] });
    const ingest  = new IngestRadiusAuth(gateway, eventRepo, new InMemorySyncStateRepository(), { now: () => NOW, retentionMonths: 12 });
    const result  = await ingest.run();
    expect(result.purgedRows).toBeGreaterThanOrEqual(1);
    const ids = (await eventRepo.list({ page: 1, pageSize: 10 })).data.map(e => e.sourceUniqueId);
    expect(ids).not.toContain('old');
    expect(ids).toContain('fresh');
  });

  it('error en purga no aborta el ingest (best-effort)', async () => {
    const eventRepo = new InMemoryRadiusAuthEventRepository();
    jest.spyOn(eventRepo, 'deleteOlderThan').mockRejectedValueOnce(new Error('purge-fail'));
    const ingest = new IngestRadiusAuth(new InMemoryRadiusOrchestratorGateway({ authEvents: [makeEvent()] }), eventRepo, new InMemorySyncStateRepository(), { now: () => NOW });
    await expect(ingest.run()).resolves.toMatchObject({ upserted: 1 });
  });

  it('SyncState: guarda cursor y lastResult ok', async () => {
    const { ingest, stateRepo } = makeUseCase([makeEvent()]);
    await ingest.run();
    const state = await stateRepo.get('radius-auth-ingest');
    expect(state?.cursor).toBe('2026-06-22T10:00:00Z');
    expect(state?.lastResult).toBe('ok');
    expect(state?.itemsSynced).toBe(1);
  });

  it('maxBatchesPerTick=2 limita la cantidad de batches de purga', async () => {
    const eventRepo = new InMemoryRadiusAuthEventRepository();
    let deleteCallCount = 0;
    const originalDelete = eventRepo.deleteOlderThan.bind(eventRepo);
    jest.spyOn(eventRepo, 'deleteOlderThan').mockImplementation(async (cutoff, batchSize) => {
      deleteCallCount++;
      return originalDelete(cutoff, batchSize);
    });
    const ingest = new IngestRadiusAuth(
      new InMemoryRadiusOrchestratorGateway({ authEvents: [makeEvent()] }),
      eventRepo,
      new InMemorySyncStateRepository(),
      { now: () => NOW, maxBatchesPerTick: 2 },
    );
    await ingest.run();
    expect(deleteCallCount).toBeLessThanOrEqual(2);
  });

  it('sin maxBatchesPerTick purga todo el backlog', async () => {
    const eventRepo = new InMemoryRadiusAuthEventRepository();
    await eventRepo.upsertMany(
      Array.from({ length: 5 }, (_, i) => ({
        sourceUniqueId: `old-${i}`,
        username: 'u', reply: 'Access-Reject' as const,
        authdate: new Date('2020-01-01T00:00:00Z'), class: null,
      })),
    );
    const ingest = new IngestRadiusAuth(
      new InMemoryRadiusOrchestratorGateway({ authEvents: [] }),
      eventRepo,
      new InMemorySyncStateRepository(),
      { now: () => NOW, retentionMonths: 1, purgeBatchSize: 2 }, // batch=2, 5 rows → 3 batches
    );
    const result = await ingest.run();
    expect(result.purgedRows).toBe(5);
  });
});

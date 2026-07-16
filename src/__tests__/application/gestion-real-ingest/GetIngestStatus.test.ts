import { GetIngestStatus } from '@application/use-cases/GetIngestStatus';
import { InMemorySyncStateRepository } from '../../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';

describe('GetIngestStatus', () => {
  it('REQ-STATUS-1: before any run → lastRunAt=null and all counts 0', async () => {
    const state = new InMemorySyncStateRepository();
    const useCase = new GetIngestStatus(state);

    const dto = await useCase.execute();

    expect(dto).toEqual({
      lastRunAt: null,
      created: 0,
      skippedDuplicate: 0,
      skippedUnmirrored: 0,
      unclassified: 0,
      skippedOrders: [],
      pregen: { created: 0, existing: 0, stale: 0, failed: 0 },
    });
  });

  it('REQ-STATUS-1: reflects last run timestamp and counts from the gr-ingest SyncState', async () => {
    const state = new InMemorySyncStateRepository();
    const lastRunAt = new Date('2026-05-29T10:00:00.000Z');
    await state.save({
      entity: 'gr-ingest',
      cursor: '29-05-2026',
      lastRunAt,
      lastResult: JSON.stringify({
        created: 5,
        skippedDuplicate: 2,
        skippedUnmirrored: 1,
        unclassified: 3,
        skippedOrders: [
          { grOrdenId: '17774', grClienteId: '205160', grContratoId: '12064', reason: 'client-unmirrored' },
        ],
      }),
      itemsSynced: 5,
    });
    const useCase = new GetIngestStatus(state);

    const dto = await useCase.execute();

    expect(dto).toEqual({
      lastRunAt: lastRunAt.toISOString(),
      created: 5,
      skippedDuplicate: 2,
      skippedUnmirrored: 1,
      unclassified: 3,
      skippedOrders: [
        { grOrdenId: '17774', grClienteId: '205160', grContratoId: '12064', reason: 'client-unmirrored' },
      ],
      // K1: rows previas al fix wave no traen pregen → degrada a ceros, jamás undefined.
      pregen: { created: 0, existing: 0, stale: 0, failed: 0 },
    });
  });

  it('tolerates a non-JSON / missing lastResult by returning zero counts', async () => {
    const state = new InMemorySyncStateRepository();
    const lastRunAt = new Date('2026-05-29T10:00:00.000Z');
    await state.save({
      entity: 'gr-ingest',
      cursor: null,
      lastRunAt,
      lastResult: 'ok',
      itemsSynced: 0,
    });
    const useCase = new GetIngestStatus(state);

    const dto = await useCase.execute();

    expect(dto).toEqual({
      lastRunAt: lastRunAt.toISOString(),
      created: 0,
      skippedDuplicate: 0,
      skippedUnmirrored: 0,
      unclassified: 0,
      skippedOrders: [],
      pregen: { created: 0, existing: 0, stale: 0, failed: 0 },
    });
  });

  it('K1: round-trips the pregen counters from the persisted lastResult', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({
      entity: 'gr-ingest',
      cursor: null,
      lastRunAt: new Date('2026-07-16T10:00:00.000Z'),
      lastResult: JSON.stringify({
        created: 2,
        pregen: { created: 1, existing: 1, stale: 3, failed: 2 },
      }),
      itemsSynced: 2,
    });
    const useCase = new GetIngestStatus(state);

    const dto = await useCase.execute();

    expect(dto.pregen).toEqual({ created: 1, existing: 1, stale: 3, failed: 2 });
  });

  it('K1: degrades a malformed pregen blob to zero counters (never throws)', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({
      entity: 'gr-ingest',
      cursor: null,
      lastRunAt: new Date('2026-07-16T10:00:00.000Z'),
      lastResult: JSON.stringify({ created: 1, pregen: 'garbage' }),
      itemsSynced: 1,
    });
    const useCase = new GetIngestStatus(state);

    const dto = await useCase.execute();

    expect(dto.created).toBe(1);
    expect(dto.pregen).toEqual({ created: 0, existing: 0, stale: 0, failed: 0 });
  });

  it('degrades a malformed skippedOrders blob to an empty list (never throws)', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({
      entity: 'gr-ingest',
      cursor: null,
      lastRunAt: new Date('2026-06-10T10:00:00.000Z'),
      lastResult: JSON.stringify({ created: 1, skippedOrders: 'garbage' }),
      itemsSynced: 1,
    });
    const useCase = new GetIngestStatus(state);

    const dto = await useCase.execute();

    expect(dto.created).toBe(1);
    expect(dto.skippedOrders).toEqual([]);
  });
});

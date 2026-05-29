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
    });
  });
});

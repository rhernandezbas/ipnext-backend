import { ResetGrClientsCursor } from '@application/use-cases/ResetGrClientsCursor';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';

describe('ResetGrClientsCursor', () => {
  it('nulls the cursor of an existing gr-clients state so the next run backfills', async () => {
    const stateRepo = new InMemorySyncStateRepository();
    await stateRepo.save({
      entity: 'gr-clients',
      cursor: '25-05-2026',
      lastRunAt: new Date('2026-05-25T10:00:00Z'),
      lastResult: 'ok',
      itemsSynced: 100,
    });

    const uc = new ResetGrClientsCursor(stateRepo);
    const result = await uc.execute();

    expect(result).toEqual({ entity: 'gr-clients', cursor: null });
    const after = await stateRepo.get('gr-clients');
    expect(after?.cursor).toBeNull();
  });

  it('is idempotent — running twice keeps the cursor null and does not throw', async () => {
    const stateRepo = new InMemorySyncStateRepository();
    await stateRepo.save({
      entity: 'gr-clients',
      cursor: '25-05-2026',
      lastRunAt: new Date('2026-05-25T10:00:00Z'),
      lastResult: 'ok',
      itemsSynced: 100,
    });

    const uc = new ResetGrClientsCursor(stateRepo);
    await uc.execute();
    const result = await uc.execute();

    expect(result.cursor).toBeNull();
    expect((await stateRepo.get('gr-clients'))?.cursor).toBeNull();
  });

  it('is a safe no-op (cursor null) when no prior state exists', async () => {
    const stateRepo = new InMemorySyncStateRepository();
    const uc = new ResetGrClientsCursor(stateRepo);

    const result = await uc.execute();

    expect(result).toEqual({ entity: 'gr-clients', cursor: null });
    expect((await stateRepo.get('gr-clients'))?.cursor).toBeNull();
  });
});

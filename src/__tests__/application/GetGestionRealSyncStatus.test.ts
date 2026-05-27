import { GetGestionRealSyncStatus } from '@application/use-cases/GetGestionRealSyncStatus';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryMirrorCountsRepository } from '@infrastructure/adapters/in-memory/InMemoryMirrorCountsRepository';

describe('GetGestionRealSyncStatus', () => {
  function makeUC(opts?: { clientCount?: number; contractCount?: number }) {
    const stateRepo = new InMemorySyncStateRepository();
    const countsRepo = new InMemoryMirrorCountsRepository();
    if (opts?.clientCount !== undefined) countsRepo.setClientCount(opts.clientCount);
    if (opts?.contractCount !== undefined) countsRepo.setContractCount(opts.contractCount);
    return { uc: new GetGestionRealSyncStatus(stateRepo, countsRepo), stateRepo, countsRepo };
  }

  it('returns hasRun=false and zero counts when no sync has run', async () => {
    const { uc } = makeUC();
    const view = await uc.execute();

    expect(view.hasRun).toBe(false);
    expect(view.entity).toBe('gr-clients');
    expect(view.clientCount).toBe(0);
    expect(view.contractCount).toBe(0);
  });

  it('returns hasRun=true and counts after a sync has run', async () => {
    const { uc, stateRepo } = makeUC({ clientCount: 42, contractCount: 17 });
    await stateRepo.save({
      entity: 'gr-clients',
      cursor: '25-05-2026',
      lastRunAt: new Date('2026-05-25T10:00:00Z'),
      lastResult: 'ok',
      itemsSynced: 100,
    });

    const view = await uc.execute();

    expect(view.hasRun).toBe(true);
    expect(view.cursor).toBe('25-05-2026');
    expect(view.itemsSynced).toBe(100);
    expect(view.clientCount).toBe(42);
    expect(view.contractCount).toBe(17);
  });

  it('returns counts independently of sync state', async () => {
    const { uc } = makeUC({ clientCount: 5, contractCount: 3 });
    const view = await uc.execute();

    expect(view.clientCount).toBe(5);
    expect(view.contractCount).toBe(3);
    expect(view.hasRun).toBe(false);
  });
});

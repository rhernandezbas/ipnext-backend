import { InMemoryGestionRealSyncConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealSyncConfigRepository';

describe('InMemoryGestionRealSyncConfigRepository', () => {
  it('first get() returns defaults when no record persisted (REQ-CFG-1)', async () => {
    const repo = new InMemoryGestionRealSyncConfigRepository();

    const config = await repo.get();

    expect(config).toEqual({
      intervalMs: 180000,
      estados: ['1', '2', '3', '4', '6'],
    });
  });

  it('update({ intervalMs }) round-trips and leaves estados untouched', async () => {
    const repo = new InMemoryGestionRealSyncConfigRepository();

    const updated = await repo.update({ intervalMs: 300000 });

    expect(updated).toEqual({
      intervalMs: 300000,
      estados: ['1', '2', '3', '4', '6'],
    });

    const reread = await repo.get();
    expect(reread).toEqual(updated);
  });

  it('update({ estados }) REPLACES the set wholesale (not merge)', async () => {
    const repo = new InMemoryGestionRealSyncConfigRepository();

    const updated = await repo.update({ estados: ['1', '6'] });

    expect(updated.estados).toEqual(['1', '6']);
    expect(updated.intervalMs).toBe(180000);

    const reread = await repo.get();
    expect(reread.estados).toEqual(['1', '6']);
  });

  it('partial patches do not reset untouched fields', async () => {
    const repo = new InMemoryGestionRealSyncConfigRepository();
    await repo.update({ estados: ['1', '2'] });

    const after = await repo.update({ intervalMs: 90000 });

    expect(after.intervalMs).toBe(90000);
    expect(after.estados).toEqual(['1', '2']);
  });
});

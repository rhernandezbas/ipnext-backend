import { InMemoryGestionRealIngestConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository';

describe('InMemoryGestionRealIngestConfigRepository', () => {
  it('first get() returns defaults when no record persisted (REQ-CFG-1)', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();

    const config = await repo.get();

    expect(config).toEqual({
      enabled: false,
      intervalMs: 180000,
      windowMonths: 12,
      fiberProjectId: null,
      wirelessProjectId: null,
    });
  });

  it('update() applies a patch and a subsequent get() round-trips it', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();

    const updated = await repo.update({
      enabled: true,
      intervalMs: 60000,
      fiberProjectId: 'p-fiber',
    });

    expect(updated).toEqual({
      enabled: true,
      intervalMs: 60000,
      windowMonths: 12,
      fiberProjectId: 'p-fiber',
      wirelessProjectId: null,
    });

    const reread = await repo.get();
    expect(reread).toEqual(updated);
  });

  it('update() with null clears a previously set project mapping', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();
    await repo.update({ wirelessProjectId: 'p-wifi' });

    const cleared = await repo.update({ wirelessProjectId: null });

    expect(cleared.wirelessProjectId).toBeNull();
  });

  it('update() merges partial patches without resetting untouched fields', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();
    await repo.update({ enabled: true, fiberProjectId: 'p-fiber' });

    const after = await repo.update({ intervalMs: 90000 });

    expect(after.enabled).toBe(true);
    expect(after.fiberProjectId).toBe('p-fiber');
    expect(after.intervalMs).toBe(90000);
  });
});

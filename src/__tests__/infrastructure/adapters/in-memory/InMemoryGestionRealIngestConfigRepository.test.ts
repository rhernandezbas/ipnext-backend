import { InMemoryGestionRealIngestConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository';

describe('InMemoryGestionRealIngestConfigRepository', () => {
  it('first get() returns defaults when no record persisted (REQ-CFG-1)', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();

    const config = await repo.get();

    expect(config).toEqual({
      intervalMs: 180000,
      windowMonths: 12,
      fiberProjectId: null,
      wirelessProjectId: null,
      sourceEstado: 'CONF',
      pppoeProfile: null,
    });
  });

  it('update() applies a patch and a subsequent get() round-trips it', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();

    const updated = await repo.update({
      intervalMs: 60000,
      fiberProjectId: 'p-fiber',
    });

    expect(updated).toEqual({
      intervalMs: 60000,
      windowMonths: 12,
      fiberProjectId: 'p-fiber',
      wirelessProjectId: null,
      sourceEstado: 'CONF',
      pppoeProfile: null,
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
    await repo.update({ windowMonths: 6, fiberProjectId: 'p-fiber' });

    const after = await repo.update({ intervalMs: 90000 });

    expect(after.windowMonths).toBe(6);
    expect(after.fiberProjectId).toBe('p-fiber');
    expect(after.intervalMs).toBe(90000);
  });

  // ── install-pppoe-pregen (K1): profile RADIUS default para la pre-provisión ──

  it('K1: default pppoeProfile is null; update() persists a value and null clears it', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();

    expect((await repo.get()).pppoeProfile).toBeNull();

    const set = await repo.update({ pppoeProfile: 'IP-Air-30-10' });
    expect(set.pppoeProfile).toBe('IP-Air-30-10');
    expect((await repo.get()).pppoeProfile).toBe('IP-Air-30-10');

    const cleared = await repo.update({ pppoeProfile: null });
    expect(cleared.pppoeProfile).toBeNull();
  });

  it('K1: an omitted pppoeProfile key leaves the persisted value untouched', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();
    await repo.update({ pppoeProfile: 'IP-Air-30-10' });

    const after = await repo.update({ intervalMs: 90000 });

    expect(after.pppoeProfile).toBe('IP-Air-30-10');
  });

  it('default sourceEstado is CONF; update() persists a new value', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();

    expect((await repo.get()).sourceEstado).toBe('CONF');

    const updated = await repo.update({ sourceEstado: 'PEND' });
    expect(updated.sourceEstado).toBe('PEND');
    expect((await repo.get()).sourceEstado).toBe('PEND');
  });
});

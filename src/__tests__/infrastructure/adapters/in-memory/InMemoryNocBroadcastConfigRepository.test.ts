/**
 * N1 (noc-broadcast) — InMemoryNocBroadcastConfigRepository: singleton get/upsert.
 * Mirrors the InMemoryGestionRealIngestConfigRepository contract: `get()` returns
 * defaults until something is persisted; `update()` merges a partial patch and
 * returns the resulting full config (present keys win, omitted keys preserved).
 */
import { InMemoryNocBroadcastConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocBroadcastConfigRepository';
import { NOC_BROADCAST_DEFAULTS } from '@domain/ports/NocBroadcastConfigRepository';

describe('InMemoryNocBroadcastConfigRepository', () => {
  it('get() returns the hardcoded defaults before any row is persisted', async () => {
    const repo = new InMemoryNocBroadcastConfigRepository();
    expect(await repo.get()).toEqual(NOC_BROADCAST_DEFAULTS);
    expect(await repo.get()).toEqual({
      enabled: false,
      evolutionBaseUrl: '',
      evolutionApiKey: '',
      evolutionInstance: '',
      targetChat: '',
      appPublicUrl: '',
    });
  });

  it('update() merges a partial patch and round-trips the full config', async () => {
    const repo = new InMemoryNocBroadcastConfigRepository();
    const updated = await repo.update({
      enabled: true,
      evolutionBaseUrl: 'http://pi.local:8080',
      evolutionApiKey: 'key-abcd',
      evolutionInstance: 'ronald noc',
      targetChat: '12036304@g.us',
      appPublicUrl: 'http://190.7.234.37:7778',
    });
    expect(updated).toEqual({
      enabled: true,
      evolutionBaseUrl: 'http://pi.local:8080',
      evolutionApiKey: 'key-abcd',
      evolutionInstance: 'ronald noc',
      targetChat: '12036304@g.us',
      appPublicUrl: 'http://190.7.234.37:7778',
    });
    expect(await repo.get()).toEqual(updated);
  });

  it('update() preserves keys that are absent from the patch', async () => {
    const repo = new InMemoryNocBroadcastConfigRepository();
    await repo.update({ evolutionApiKey: 'secret-1234', evolutionInstance: 'ronald noc' });
    // A later patch that omits the apiKey must NOT wipe it.
    const after = await repo.update({ targetChat: '999@g.us' });
    expect(after.evolutionApiKey).toBe('secret-1234');
    expect(after.evolutionInstance).toBe('ronald noc');
    expect(after.targetChat).toBe('999@g.us');
  });

  it('update() can set enabled explicitly to false (false is a value, not "omitted")', async () => {
    const repo = new InMemoryNocBroadcastConfigRepository();
    await repo.update({ enabled: true });
    const after = await repo.update({ enabled: false });
    expect(after.enabled).toBe(false);
  });
});

/**
 * #47 — InMemoryGigaredConfigRepository: defaults before any row, partial update.
 * Contract parity with the Prisma adapter (same get/update semantics).
 */
import { InMemoryGigaredConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGigaredConfigRepository';

describe('InMemoryGigaredConfigRepository (#47)', () => {
  it('get() returns defaults before any update (apiKey empty = unconfigured)', async () => {
    const repo = new InMemoryGigaredConfigRepository();
    const cfg = await repo.get();
    expect(cfg.apiKey).toBe('');
    expect(cfg.baseUrl).toBe('https://partners.gigaredsa.com.ar/api/v1');
    expect(typeof cfg.updatedAt).toBe('string');
  });

  it('update({ apiKey }) sets the key and leaves baseUrl unchanged', async () => {
    const repo = new InMemoryGigaredConfigRepository();
    const result = await repo.update({ apiKey: 'abcdef1234' });
    expect(result.apiKey).toBe('abcdef1234');
    expect(result.baseUrl).toBe('https://partners.gigaredsa.com.ar/api/v1');
    // persisted
    expect((await repo.get()).apiKey).toBe('abcdef1234');
  });

  it('update({ baseUrl }) leaves a previously-set apiKey unchanged (partial patch)', async () => {
    const repo = new InMemoryGigaredConfigRepository();
    await repo.update({ apiKey: 'KEY' });
    const result = await repo.update({ baseUrl: 'https://other.example/api' });
    expect(result.apiKey).toBe('KEY');
    expect(result.baseUrl).toBe('https://other.example/api');
  });

  it('update({ apiKey: "" }) clears the key (back to unconfigured)', async () => {
    const repo = new InMemoryGigaredConfigRepository();
    await repo.update({ apiKey: 'KEY' });
    const result = await repo.update({ apiKey: '' });
    expect(result.apiKey).toBe('');
  });
});

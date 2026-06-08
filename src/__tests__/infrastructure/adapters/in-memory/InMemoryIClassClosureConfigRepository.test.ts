import { InMemoryIClassClosureConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassClosureConfigRepository';

describe('InMemoryIClassClosureConfigRepository', () => {
  it('first get() returns defaults when no record exists (spec scenario 1)', async () => {
    const repo = new InMemoryIClassClosureConfigRepository();

    const config = await repo.get();

    expect(config).toEqual({
      closureIntervalMs: 600000,
      autocompleteIntervalMs: 900000,
    });
  });

  it('partial update leaves untouched field unchanged (spec scenario 2)', async () => {
    const repo = new InMemoryIClassClosureConfigRepository();

    const updated = await repo.update({ closureIntervalMs: 120000 });

    expect(updated).toEqual({
      closureIntervalMs: 120000,
      autocompleteIntervalMs: 900000,
    });

    const reread = await repo.get();
    expect(reread.autocompleteIntervalMs).toBe(900000);
    expect(reread.closureIntervalMs).toBe(120000);
  });
});

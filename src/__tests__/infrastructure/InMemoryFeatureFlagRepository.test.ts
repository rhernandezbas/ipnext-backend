import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';

describe('InMemoryFeatureFlagRepository', () => {
  it('list() returns all seeded flags', async () => {
    const repo = new InMemoryFeatureFlagRepository();
    repo.seed('iclass-integration', false);
    repo.seed('other-flag', true);

    const flags = await repo.list();
    expect(flags).toHaveLength(2);
    const keys = flags.map(f => f.key).sort();
    expect(keys).toEqual(['iclass-integration', 'other-flag']);
    expect(flags.every(f => typeof f.updatedAt === 'string')).toBe(true);
  });

  it('list() returns empty array when no flags', async () => {
    const repo = new InMemoryFeatureFlagRepository();
    expect(await repo.list()).toEqual([]);
  });

  it('get() returns an existing flag', async () => {
    const repo = new InMemoryFeatureFlagRepository();
    repo.seed('iclass-integration', false);

    const flag = await repo.get('iclass-integration');
    expect(flag).not.toBeNull();
    expect(flag!.key).toBe('iclass-integration');
    expect(flag!.enabled).toBe(false);
  });

  it('get() returns null for an unknown flag', async () => {
    const repo = new InMemoryFeatureFlagRepository();
    expect(await repo.get('no-existe')).toBeNull();
  });

  it('setEnabled() toggles and persists the value', async () => {
    const repo = new InMemoryFeatureFlagRepository();
    repo.seed('iclass-integration', false);

    const updated = await repo.setEnabled('iclass-integration', true);
    expect(updated.enabled).toBe(true);

    const after = await repo.get('iclass-integration');
    expect(after!.enabled).toBe(true);
  });

  it('setEnabled() refreshes updatedAt', async () => {
    const repo = new InMemoryFeatureFlagRepository();
    repo.seed('iclass-integration', false);
    const before = (await repo.get('iclass-integration'))!.updatedAt;

    const updated = await repo.setEnabled('iclass-integration', true);
    expect(typeof updated.updatedAt).toBe('string');
    expect(updated.updatedAt >= before).toBe(true);
  });
});

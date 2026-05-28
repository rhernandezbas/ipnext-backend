/**
 * TDD — ListIClassSoTypes use case
 * Covers REQ-LIST-CAT-1 scenarios.
 */
import { InMemoryIClassSoTypeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository';
import { ListIClassSoTypes } from '../../application/use-cases/ListIClassSoTypes';

async function seedRepo(repo: InMemoryIClassSoTypeRepository) {
  await repo.upsertByCode({ code: 'INSTALL', description: 'Installation' });
  await repo.upsertByCode({ code: 'REPAIR', description: 'Repair' });
  await repo.upsertByCode({ code: 'MAINT', description: 'Maintenance' });
  // deactivate MAINT
  await repo.markInactiveExcept(['INSTALL', 'REPAIR']);
}

describe('ListIClassSoTypes', () => {
  it('no filter → returns all types (active and inactive)', async () => {
    const repo = new InMemoryIClassSoTypeRepository();
    await seedRepo(repo);
    const useCase = new ListIClassSoTypes(repo);

    const result = await useCase.execute();

    expect(result).toHaveLength(3);
  });

  it('{ active: true } → returns only active types', async () => {
    const repo = new InMemoryIClassSoTypeRepository();
    await seedRepo(repo);
    const useCase = new ListIClassSoTypes(repo);

    const result = await useCase.execute({ active: true });

    expect(result).toHaveLength(2);
    expect(result.every((e) => e.active)).toBe(true);
  });

  it('{ active: false } → returns only inactive types', async () => {
    const repo = new InMemoryIClassSoTypeRepository();
    await seedRepo(repo);
    const useCase = new ListIClassSoTypes(repo);

    const result = await useCase.execute({ active: false });

    expect(result).toHaveLength(1);
    expect(result[0].code).toBe('MAINT');
    expect(result[0].active).toBe(false);
  });

  it('returns DTOs (not raw entities — same shape as IClassSoType)', async () => {
    const repo = new InMemoryIClassSoTypeRepository();
    await repo.upsertByCode({ code: 'INSTALL', description: 'Installation' });
    const useCase = new ListIClassSoTypes(repo);

    const result = await useCase.execute();

    expect(result[0]).toMatchObject({
      code: 'INSTALL',
      description: 'Installation',
      active: true,
    });
    expect(result[0].id).toBeDefined();
    expect(result[0].createdAt).toBeDefined();
    expect(result[0].updatedAt).toBeDefined();
    expect(result[0].lastSyncedAt).toBeDefined();
  });

  it('empty repo → returns empty array', async () => {
    const repo = new InMemoryIClassSoTypeRepository();
    const useCase = new ListIClassSoTypes(repo);

    const result = await useCase.execute();
    expect(result).toEqual([]);
  });
});

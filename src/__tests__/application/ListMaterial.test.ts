import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { ListMaterial } from '@application/use-cases/ListMaterial';

describe('ListMaterial', () => {
  it('returns all materials ordered by sortOrder', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    await repo.create({ name: 'CABLE_FIBRA', sortOrder: 1 });
    await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });

    const list = new ListMaterial(repo);
    const result = await list.execute();

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('CABLE_UTP');
    expect(result[1].name).toBe('CABLE_FIBRA');
  });

  it('returns empty array when no materials', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const list = new ListMaterial(repo);
    const result = await list.execute();
    expect(result).toHaveLength(0);
  });
});

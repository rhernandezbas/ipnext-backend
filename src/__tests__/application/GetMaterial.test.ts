import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { GetMaterial } from '@application/use-cases/GetMaterial';
import { MaterialNotFoundError } from '@domain/errors/inventory';

describe('GetMaterial', () => {
  it('returns material by id', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const item = await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });

    const get = new GetMaterial(repo);
    const result = await get.execute(item.id);

    expect(result.id).toBe(item.id);
    expect(result.name).toBe('CABLE_UTP');
  });

  it('throws MaterialNotFoundError for unknown id', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const get = new GetMaterial(repo);
    await expect(get.execute('nonexistent')).rejects.toBeInstanceOf(MaterialNotFoundError);
  });
});

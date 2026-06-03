import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { DeleteMaterial } from '@application/use-cases/DeleteMaterial';
import {
  MaterialNotFoundError,
  MaterialProtectedError,
  MaterialInUseError,
} from '@domain/errors/inventory';

describe('DeleteMaterial', () => {
  it('happy path: deletes an unused, unprotected material', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const item = await repo.create({ name: 'PRECINTO', sortOrder: 2 });

    const del = new DeleteMaterial(repo);
    await del.execute(item.id);

    expect(await repo.getById(item.id)).toBeNull();
  });

  it('throws MaterialNotFoundError for unknown id', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const del = new DeleteMaterial(repo);
    await expect(del.execute('nonexistent')).rejects.toBeInstanceOf(MaterialNotFoundError);
  });

  it('throws MaterialProtectedError for OTRO BEFORE checking in-use count', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const otro = await repo.create({ name: 'OTRO', sortOrder: 6 });
    // also mark as in-use — but protected check should still fire first
    repo.usageCounts[otro.id] = 99;

    const del = new DeleteMaterial(repo);
    await expect(del.execute(otro.id)).rejects.toBeInstanceOf(MaterialProtectedError);
  });

  it('throws MaterialInUseError when the material has consumption records', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const item = await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });
    repo.usageCounts[item.id] = 3;

    const del = new DeleteMaterial(repo);
    await expect(del.execute(item.id)).rejects.toBeInstanceOf(MaterialInUseError);
  });

  it('MaterialInUseError carries the count', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const item = await repo.create({ name: 'ROSETA', sortOrder: 5 });
    repo.usageCounts[item.id] = 7;

    const del = new DeleteMaterial(repo);
    try {
      await del.execute(item.id);
      fail('expected error');
    } catch (e: any) {
      expect(e).toBeInstanceOf(MaterialInUseError);
      expect(e.usageCount).toBe(7);
    }
  });
});

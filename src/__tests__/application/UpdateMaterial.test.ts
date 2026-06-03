import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { UpdateMaterial } from '@application/use-cases/UpdateMaterial';
import { MaterialNotFoundError, MaterialNameConflictError } from '@domain/errors/inventory';

describe('UpdateMaterial', () => {
  it('updates non-name fields without conflict check', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const item = await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });

    const update = new UpdateMaterial(repo);
    const result = await update.execute(item.id, { label: 'Cable UTP cat6', unit: 'm', sortOrder: 3 });

    expect(result.label).toBe('Cable UTP cat6');
    expect(result.unit).toBe('m');
    expect(result.sortOrder).toBe(3);
    expect(result.name).toBe('CABLE_UTP');
  });

  it('normalizes name to UPPERCASE on update', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const item = await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });

    const update = new UpdateMaterial(repo);
    const result = await update.execute(item.id, { name: 'roseta' });

    expect(result.name).toBe('ROSETA');
  });

  it('throws MaterialNameConflictError when renaming to an existing name', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });
    const item2 = await repo.create({ name: 'CABLE_FIBRA', sortOrder: 1 });

    const update = new UpdateMaterial(repo);
    await expect(update.execute(item2.id, { name: 'cable_utp' })).rejects.toBeInstanceOf(MaterialNameConflictError);
  });

  it('allows renaming to the same name (no conflict with self)', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const item = await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });

    const update = new UpdateMaterial(repo);
    const result = await update.execute(item.id, { name: 'cable_utp' });

    expect(result.name).toBe('CABLE_UTP');
  });

  it('throws MaterialNotFoundError for unknown id', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const update = new UpdateMaterial(repo);
    await expect(update.execute('nonexistent', { label: 'x' })).rejects.toBeInstanceOf(MaterialNotFoundError);
  });
});

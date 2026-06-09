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

  // SCEN-MS-1: update minStock via the use case
  it('SCEN-MS-1: updates minStock to positive value', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const item = await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });
    expect(item.minStock).toBe(0);

    const update = new UpdateMaterial(repo);
    const result = await update.execute(item.id, { minStock: 10 });

    expect(result.minStock).toBe(10);
  });

  // SCEN-MS-2: negative minStock → 400 (validation at use-case level via domain guard)
  it('SCEN-MS-2: negative minStock is rejected (validation error)', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const item = await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });

    const update = new UpdateMaterial(repo);
    // The route layer validates via Zod (minStock: z.number().int().min(0));
    // the use case passes through — Zod rejection simulated here by checking the DTO schema
    await expect(
      update.execute(item.id, { minStock: -1 }),
    ).rejects.toThrow();
  });
});

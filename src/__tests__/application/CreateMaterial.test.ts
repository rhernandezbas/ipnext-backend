import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { CreateMaterial } from '@application/use-cases/CreateMaterial';
import { MaterialNameConflictError } from '@domain/errors/inventory';

describe('CreateMaterial', () => {
  it('normalizes name to UPPERCASE and creates with active=true and default unit=unidad', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const create = new CreateMaterial(repo);

    const result = await create.execute({ name: 'cable_utp', sortOrder: 0 });

    expect(result.name).toBe('CABLE_UTP');
    expect(result.active).toBe(true);
    expect(result.unit).toBe('unidad');
  });

  it('trims whitespace from name before normalizing', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const create = new CreateMaterial(repo);

    const result = await create.execute({ name: '  roseta  ', sortOrder: 0 });

    expect(result.name).toBe('ROSETA');
  });

  it('uses provided unit instead of default', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const create = new CreateMaterial(repo);

    const result = await create.execute({ name: 'CABLE_FIBRA', unit: 'm', sortOrder: 1 });

    expect(result.unit).toBe('m');
  });

  it('throws MaterialNameConflictError on duplicate name (case-insensitive)', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const create = new CreateMaterial(repo);
    await create.execute({ name: 'CABLE_UTP', sortOrder: 0 });

    await expect(create.execute({ name: 'cable_utp', sortOrder: 1 })).rejects.toBeInstanceOf(MaterialNameConflictError);
  });

  it('does not insert a row when conflict is detected', async () => {
    const repo = new InMemoryMaterialCatalogRepository();
    const create = new CreateMaterial(repo);
    await create.execute({ name: 'CABLE_UTP', sortOrder: 0 });

    try { await create.execute({ name: 'CABLE_UTP', sortOrder: 1 }); } catch { /* expected */ }

    const all = await repo.list();
    expect(all).toHaveLength(1);
  });
});

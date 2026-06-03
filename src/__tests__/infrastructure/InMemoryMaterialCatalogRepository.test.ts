import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';

describe('InMemoryMaterialCatalogRepository', () => {
  let repo: InMemoryMaterialCatalogRepository;

  beforeEach(() => {
    repo = new InMemoryMaterialCatalogRepository();
  });

  it('list() returns entries ordered by sortOrder ASC', async () => {
    await repo.create({ name: 'CABLE_FIBRA', sortOrder: 1 });
    await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });
    await repo.create({ name: 'PRECINTO', sortOrder: 2 });
    const all = await repo.list();
    expect(all.map(e => e.name)).toEqual(['CABLE_UTP', 'CABLE_FIBRA', 'PRECINTO']);
  });

  it('getById returns the entry or null', async () => {
    const created = await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });
    const found = await repo.getById(created.id);
    expect(found).not.toBeNull();
    expect(found?.name).toBe('CABLE_UTP');
    expect(await repo.getById('nonexistent')).toBeNull();
  });

  it('getByName is case-insensitive', async () => {
    await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });
    expect(await repo.getByName('cable_utp')).not.toBeNull();
    expect(await repo.getByName('CABLE_UTP')).not.toBeNull();
    expect(await repo.getByName('Cable_Utp')).not.toBeNull();
    expect(await repo.getByName('PRECINTO')).toBeNull();
  });

  it('create assigns a UUID id and defaults active=true and unit=null', async () => {
    const item = await repo.create({ name: 'ROSETA', sortOrder: 5 });
    expect(item.id).toBeTruthy();
    expect(typeof item.id).toBe('string');
    expect(item.active).toBe(true);
    expect(item.name).toBe('ROSETA');
    expect(item.sortOrder).toBe(5);
    expect(item.unit).toBeNull();
  });

  it('create stores the unit when provided', async () => {
    const item = await repo.create({ name: 'CABLE_UTP', unit: 'm', sortOrder: 0 });
    expect(item.unit).toBe('m');
  });

  it('update applies partial fields only; unknown id returns null', async () => {
    const item = await repo.create({ name: 'PRECINTO', sortOrder: 2 });
    const updated = await repo.update(item.id, { label: 'Precinto nylon', sortOrder: 3, unit: 'unidad' });
    expect(updated).not.toBeNull();
    expect(updated?.label).toBe('Precinto nylon');
    expect(updated?.sortOrder).toBe(3);
    expect(updated?.unit).toBe('unidad');
    expect(updated?.name).toBe('PRECINTO'); // unchanged

    expect(await repo.update('nonexistent', { label: 'x' })).toBeNull();
  });

  it('delete removes the entry and returns true; unknown id returns false', async () => {
    const item = await repo.create({ name: 'ROSETA', sortOrder: 5 });
    expect(await repo.delete(item.id)).toBe(true);
    expect(await repo.getById(item.id)).toBeNull();
    expect(await repo.delete('nonexistent')).toBe(false);
  });

  it('countInUse reads from the public usageCounts seam (by id)', async () => {
    const item = await repo.create({ name: 'CABLE_UTP', sortOrder: 0 });
    repo.usageCounts[item.id] = 5;
    expect(await repo.countInUse(item.id)).toBe(5);
    expect(await repo.countInUse('other-id')).toBe(0);
  });

  it('listActiveNames returns only active=true names UPPERCASE', async () => {
    await repo.create({ name: 'CABLE_UTP', sortOrder: 0, active: true });
    await repo.create({ name: 'cable_fibra', sortOrder: 1, active: false });
    await repo.create({ name: 'precinto', sortOrder: 2, active: true });
    const names = await repo.listActiveNames();
    expect(names).toContain('CABLE_UTP');
    expect(names).toContain('PRECINTO');
    expect(names).not.toContain('CABLE_FIBRA');
    expect(names).not.toContain('cable_fibra');
  });
});

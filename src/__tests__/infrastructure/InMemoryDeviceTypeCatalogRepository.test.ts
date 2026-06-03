import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';

describe('InMemoryDeviceTypeCatalogRepository', () => {
  let repo: InMemoryDeviceTypeCatalogRepository;

  beforeEach(() => {
    repo = new InMemoryDeviceTypeCatalogRepository();
  });

  it('list() returns entries ordered by sortOrder ASC', async () => {
    await repo.create({ name: 'ROUTER', sortOrder: 1 });
    await repo.create({ name: 'ONU', sortOrder: 0 });
    await repo.create({ name: 'ANTENA', sortOrder: 2 });
    const all = await repo.list();
    expect(all.map(e => e.name)).toEqual(['ONU', 'ROUTER', 'ANTENA']);
  });

  it('getById returns the entry or null', async () => {
    const created = await repo.create({ name: 'ONU', sortOrder: 0 });
    const found = await repo.getById(created.id);
    expect(found).not.toBeNull();
    expect(found?.name).toBe('ONU');
    expect(await repo.getById('nonexistent')).toBeNull();
  });

  it('getByName is case-insensitive', async () => {
    await repo.create({ name: 'ONU', sortOrder: 0 });
    expect(await repo.getByName('onu')).not.toBeNull();
    expect(await repo.getByName('ONU')).not.toBeNull();
    expect(await repo.getByName('Onu')).not.toBeNull();
    expect(await repo.getByName('ROUTER')).toBeNull();
  });

  it('create assigns a UUID id and defaults active=true', async () => {
    const item = await repo.create({ name: 'ROUTER', sortOrder: 1 });
    expect(item.id).toBeTruthy();
    expect(typeof item.id).toBe('string');
    expect(item.active).toBe(true);
    expect(item.name).toBe('ROUTER');
    expect(item.sortOrder).toBe(1);
  });

  it('update applies partial fields only; unknown id returns null', async () => {
    const item = await repo.create({ name: 'ANTENA', sortOrder: 2 });
    const updated = await repo.update(item.id, { label: 'Antena direccional', sortOrder: 3 });
    expect(updated).not.toBeNull();
    expect(updated?.label).toBe('Antena direccional');
    expect(updated?.sortOrder).toBe(3);
    expect(updated?.name).toBe('ANTENA'); // unchanged

    expect(await repo.update('nonexistent', { label: 'x' })).toBeNull();
  });

  it('delete removes the entry and returns true; unknown id returns false', async () => {
    const item = await repo.create({ name: 'REPETIDOR', sortOrder: 3 });
    expect(await repo.delete(item.id)).toBe(true);
    expect(await repo.getById(item.id)).toBeNull();
    expect(await repo.delete('nonexistent')).toBe(false);
  });

  it('countInUse reads from the public itemCounts seam', async () => {
    await repo.create({ name: 'ONU', sortOrder: 0 });
    repo.itemCounts['ONU'] = 5;
    expect(await repo.countInUse('ONU')).toBe(5);
    expect(await repo.countInUse('ROUTER')).toBe(0);
  });

  it('listActiveNames returns only active=true names UPPERCASE', async () => {
    await repo.create({ name: 'ONU', sortOrder: 0, active: true });
    await repo.create({ name: 'router', sortOrder: 1, active: false });
    await repo.create({ name: 'antena', sortOrder: 2, active: true });
    const names = await repo.listActiveNames();
    expect(names).toContain('ONU');
    expect(names).toContain('ANTENA');
    expect(names).not.toContain('ROUTER');
    expect(names).not.toContain('router');
  });
});

import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

describe('InMemoryServiceCatalogRepository (port parity)', () => {
  let repo: InMemoryServiceCatalogRepository;

  beforeEach(() => {
    repo = new InMemoryServiceCatalogRepository();
  });

  it('list() returns entries ordered by sortOrder ASC', async () => {
    await repo.create({ name: 'TV', sortOrder: 1 });
    await repo.create({ name: 'INTERNET', sortOrder: 0 });
    await repo.create({ name: 'VOZ', sortOrder: 2 });
    const all = await repo.list();
    expect(all.map(e => e.name)).toEqual(['INTERNET', 'TV', 'VOZ']);
  });

  it('list({ active: true }) excludes inactive entries', async () => {
    await repo.create({ name: 'INTERNET', sortOrder: 0, active: true });
    await repo.create({ name: 'OTROS', sortOrder: 4, active: false });
    const active = await repo.list({ active: true });
    expect(active.map(e => e.name)).toEqual(['INTERNET']);
  });

  it('getById returns the entry or null', async () => {
    const created = await repo.create({ name: 'INTERNET', sortOrder: 0 });
    expect((await repo.getById(created.id))?.name).toBe('INTERNET');
    expect(await repo.getById('nope')).toBeNull();
  });

  it('getByName is case-insensitive', async () => {
    await repo.create({ name: 'INTERNET', sortOrder: 0 });
    expect(await repo.getByName('internet')).not.toBeNull();
    expect(await repo.getByName('TV')).toBeNull();
  });

  it('create defaults active=true and exposes timestamps', async () => {
    const item = await repo.create({ name: 'INTERNET', sortOrder: 0 });
    expect(item.id).toBeTruthy();
    expect(item.active).toBe(true);
    expect(item.createdAt).toBeTruthy();
    expect(item.updatedAt).toBeTruthy();
  });

  it('update patches fields and returns null for unknown id', async () => {
    const item = await repo.create({ name: 'INTERNET', sortOrder: 0 });
    const updated = await repo.update(item.id, { label: 'Hogar', active: false });
    expect(updated?.label).toBe('Hogar');
    expect(updated?.active).toBe(false);
    expect(await repo.update('nope', { label: 'x' })).toBeNull();
  });

  it('delete removes the entry and returns false for unknown id', async () => {
    const item = await repo.create({ name: 'INTERNET', sortOrder: 0 });
    expect(await repo.delete(item.id)).toBe(true);
    expect(await repo.getById(item.id)).toBeNull();
    expect(await repo.delete('nope')).toBe(false);
  });

  it('countInUse reads the itemCounts seam keyed by id', async () => {
    const item = await repo.create({ name: 'INTERNET', sortOrder: 0 });
    expect(await repo.countInUse(item.id)).toBe(0);
    repo.itemCounts[item.id] = 7;
    expect(await repo.countInUse(item.id)).toBe(7);
  });
});

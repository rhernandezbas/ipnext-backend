import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';

describe('InMemoryTicketAreaCatalogRepository', () => {
  let repo: InMemoryTicketAreaCatalogRepository;

  beforeEach(() => {
    repo = new InMemoryTicketAreaCatalogRepository();
  });

  it('starts empty', async () => {
    expect(await repo.list()).toHaveLength(0);
  });

  it('creates and retrieves by id', async () => {
    const area = await repo.create({ name: 'Soporte', color: '#6366f1' });
    expect(area.id).toBeTruthy();
    const found = await repo.getById(area.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Soporte');
  });

  it('getByName is case-insensitive', async () => {
    await repo.create({ name: 'Soporte', color: '#6366f1' });
    const found = await repo.getByName('soporte');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Soporte');
  });

  it('getByName returns null when not found', async () => {
    expect(await repo.getByName('Nonexistent')).toBeNull();
  });

  it('getById returns null when not found', async () => {
    expect(await repo.getById('nonexistent-id')).toBeNull();
  });

  it('update changes the name', async () => {
    const area = await repo.create({ name: 'Soporte', color: '#6366f1' });
    const updated = await repo.update(area.id, { name: 'Soporte Técnico' });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Soporte Técnico');
  });

  it('update returns null for missing id', async () => {
    expect(await repo.update('missing', { name: 'X' })).toBeNull();
  });

  it('delete removes the area', async () => {
    const area = await repo.create({ name: 'Soporte', color: '#6366f1' });
    const ok = await repo.delete(area.id);
    expect(ok).toBe(true);
    expect(await repo.getById(area.id)).toBeNull();
  });

  it('delete returns false for missing id', async () => {
    expect(await repo.delete('missing')).toBe(false);
  });

  it('countInUse returns ticket count by area id', async () => {
    const area = await repo.create({ name: 'Soporte', color: '#6366f1' });
    repo.ticketCounts[area.id] = 5;
    expect(await repo.countInUse(area.id)).toBe(5);
  });

  it('countInUse returns 0 when no tickets', async () => {
    const area = await repo.create({ name: 'Soporte', color: '#6366f1' });
    expect(await repo.countInUse(area.id)).toBe(0);
  });
});

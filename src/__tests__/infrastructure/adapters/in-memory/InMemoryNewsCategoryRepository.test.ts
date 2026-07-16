import { InMemoryNewsCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsCategoryRepository';
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import type { NewsCategoryRepository } from '@domain/ports/NewsCategoryRepository';

describe('InMemoryNewsCategoryRepository', () => {
  it('implements the NewsCategoryRepository port', () => {
    const repo: NewsCategoryRepository = new InMemoryNewsCategoryRepository();
    expect(typeof repo.list).toBe('function');
    expect(typeof repo.findById).toBe('function');
    expect(typeof repo.findByName).toBe('function');
    expect(typeof repo.create).toBe('function');
    expect(typeof repo.update).toBe('function');
    expect(typeof repo.delete).toBe('function');
    expect(typeof repo.countPosts).toBe('function');
  });

  it('starts empty', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    expect(await repo.list()).toHaveLength(0);
  });

  it('creates and retrieves by id', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const cat = await repo.create({ name: 'General', color: '#64748b' });
    expect(cat.id).toBeTruthy();
    const found = await repo.findById(cat.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('General');
    expect(found!.color).toBe('#64748b');
  });

  it('findById returns null when not found', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    expect(await repo.findById('missing')).toBeNull();
  });

  it('findByName is case-insensitive and returns null when not found', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    await repo.create({ name: 'Comercial', color: '#10b981' });
    const found = await repo.findByName('comercial');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Comercial');
    expect(await repo.findByName('Nonexistent')).toBeNull();
  });

  it('update changes name/color', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const cat = await repo.create({ name: 'General', color: '#64748b' });
    const updated = await repo.update(cat.id, { name: 'General 2', color: '#111111' });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('General 2');
    expect(updated!.color).toBe('#111111');
  });

  it('update returns null for missing id', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    expect(await repo.update('missing', { name: 'X' })).toBeNull();
  });

  it('delete removes the category', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const cat = await repo.create({ name: 'General', color: '#64748b' });
    await repo.delete(cat.id);
    expect(await repo.findById(cat.id)).toBeNull();
  });

  it('delete on a missing id is a no-op (does not throw)', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    await expect(repo.delete('missing')).resolves.toBeUndefined();
  });

  it('countPosts defaults to 0 when no post repo is attached', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const cat = await repo.create({ name: 'General', color: '#64748b' });
    expect(await repo.countPosts(cat.id)).toBe(0);
  });

  // review fix M3: countPosts used to be a hand-set `postCounts` seam. It now counts
  // REAL posts against the paired InMemoryNewsPostRepository (attachPostRepo), matching
  // PrismaNewsCategoryRepository.countPosts (COUNT against the newsPost table).
  it('countPosts reflects REAL posts once a paired InMemoryNewsPostRepository is attached (M3)', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    const postRepo = new InMemoryNewsPostRepository(repo);
    repo.attachPostRepo(postRepo);

    const withPosts = await repo.create({ name: 'Red', color: '#6366f1' });
    const empty = await repo.create({ name: 'Vacía', color: '#000000' });
    await postRepo.create({ title: 'T1', body: 'B', categoryId: withPosts.id, authorId: 'a', authorName: 'A' });
    await postRepo.create({ title: 'T2', body: 'B', categoryId: withPosts.id, authorId: 'a', authorName: 'A' });

    expect(await repo.countPosts(withPosts.id)).toBe(2);
    expect(await repo.countPosts(empty.id)).toBe(0);
  });

  // review fix L10: list() didn't sort — parity gap vs PrismaNewsCategoryRepository.list
  // (`orderBy: { name: 'asc' }`). One-liner fix, pinned here.
  it('list orders by name ASC (parity with Prisma orderBy)', async () => {
    const repo = new InMemoryNewsCategoryRepository();
    await repo.create({ name: 'General', color: '#64748b' });
    await repo.create({ name: 'Campañas', color: '#f59e0b' });
    await repo.create({ name: 'Comercial', color: '#10b981' });

    const names = (await repo.list()).map((c) => c.name);
    expect(names).toEqual(['Campañas', 'Comercial', 'General']);
  });
});

/**
 * InMemoryNewsPostRepository — port-parity tests (spec NEWS-PORT-1 / NEWS-PORT-2).
 * Covers: create/update, pinned+publishedAt ordering, per-user read-state,
 * category + archived filters, markRead idempotency, countUnread, setArchived.
 */
import { InMemoryNewsPostRepository } from '@infrastructure/adapters/in-memory/InMemoryNewsPostRepository';
import type { NewsPostRepository, CreateNewsPostData } from '@domain/ports/NewsPostRepository';

function baseInput(overrides: Partial<CreateNewsPostData> = {}): CreateNewsPostData {
  return {
    title: 'Título',
    body: 'Cuerpo',
    categoryId: 'cat-1',
    authorId: 'u-author',
    authorName: 'Ana',
    ...overrides,
  };
}

describe('InMemoryNewsPostRepository', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('implements the NewsPostRepository port', () => {
    const repo: NewsPostRepository = new InMemoryNewsPostRepository();
    expect(typeof repo.create).toBe('function');
    expect(typeof repo.update).toBe('function');
    expect(typeof repo.findById).toBe('function');
    expect(typeof repo.list).toBe('function');
    expect(typeof repo.setArchived).toBe('function');
    expect(typeof repo.markRead).toBe('function');
    expect(typeof repo.countUnread).toBe('function');
  });

  it('create stamps id + publishedAt (now) + defaults pinned to false', async () => {
    const repo = new InMemoryNewsPostRepository();
    const post = await repo.create(baseInput());
    expect(post.id).toBeTruthy();
    expect(post.pinned).toBe(false);
    expect(post.publishedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(post.archivedAt).toBeNull();
  });

  it('update changes title/body/categoryId/pinned', async () => {
    const repo = new InMemoryNewsPostRepository();
    const post = await repo.create(baseInput());
    const updated = await repo.update(post.id, { title: 'Nuevo título', pinned: true });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Nuevo título');
    expect(updated!.pinned).toBe(true);
  });

  it('update returns null for missing id', async () => {
    const repo = new InMemoryNewsPostRepository();
    expect(await repo.update('missing', { title: 'X' })).toBeNull();
  });

  // ─── Ordering: pinned DESC, publishedAt DESC ─────────────────────────────────

  it('list orders pinned DESC, publishedAt DESC', async () => {
    const repo = new InMemoryNewsPostRepository();

    jest.setSystemTime(new Date('2026-01-01T00:00:00Z')); // old
    const a = await repo.create(baseInput({ title: 'A', pinned: true }));

    jest.setSystemTime(new Date('2026-01-02T00:00:00Z')); // new
    const b = await repo.create(baseInput({ title: 'B', pinned: false }));
    const c = await repo.create(baseInput({ title: 'C', pinned: true }));

    const items = await repo.list({}, 'u1');
    expect(items.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
  });

  // ─── Read-state per usuario ───────────────────────────────────────────────────

  it('list carries per-user read state', async () => {
    const repo = new InMemoryNewsPostRepository();
    const post = await repo.create(baseInput());
    await repo.markRead(post.id, 'u1');

    const forU1 = await repo.list({}, 'u1');
    const forU2 = await repo.list({}, 'u2');
    expect(forU1[0]!.read).toBe(true);
    expect(forU2[0]!.read).toBe(false);
  });

  it('findById carries per-user read state and returns null for missing id', async () => {
    const repo = new InMemoryNewsPostRepository();
    const post = await repo.create(baseInput());
    await repo.markRead(post.id, 'u1');

    expect((await repo.findById(post.id, 'u1'))!.read).toBe(true);
    expect((await repo.findById(post.id, 'u2'))!.read).toBe(false);
    expect(await repo.findById('missing', 'u1')).toBeNull();
  });

  // ─── Filtro categoría ─────────────────────────────────────────────────────────

  it('list filters by categoryId', async () => {
    const repo = new InMemoryNewsPostRepository();
    await repo.create(baseInput({ categoryId: 'cat-x' }));
    await repo.create(baseInput({ categoryId: 'cat-y' }));
    await repo.create(baseInput({ categoryId: 'cat-x' }));

    const items = await repo.list({ categoryId: 'cat-x' }, 'u1');
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.categoryId === 'cat-x')).toBe(true);
  });

  // ─── Archivadas: excluidas por default / solo-archivadas con archived:true ───

  it('excludes archived posts by default; archived:true returns only archived', async () => {
    const repo = new InMemoryNewsPostRepository();
    const active = await repo.create(baseInput({ title: 'Activo' }));
    const toArchive = await repo.create(baseInput({ title: 'A archivar' }));
    await repo.setArchived(toArchive.id, true);

    const defaultList = await repo.list({}, 'u1');
    expect(defaultList.map((i) => i.id)).toEqual([active.id]);

    const archivedList = await repo.list({ archived: true }, 'u1');
    expect(archivedList.map((i) => i.id)).toEqual([toArchive.id]);
  });

  // ─── setArchived set/clear ─────────────────────────────────────────────────────

  it('setArchived(true) stamps archivedAt; setArchived(false) clears it', async () => {
    const repo = new InMemoryNewsPostRepository();
    const post = await repo.create(baseInput());

    const archived = await repo.setArchived(post.id, true);
    expect(archived!.archivedAt).toEqual(new Date('2026-01-01T00:00:00Z'));

    const restored = await repo.setArchived(post.id, false);
    expect(restored!.archivedAt).toBeNull();
  });

  it('setArchived returns null for missing id', async () => {
    const repo = new InMemoryNewsPostRepository();
    expect(await repo.setArchived('missing', true)).toBeNull();
  });

  // ─── markRead idempotente + countUnread ────────────────────────────────────────

  it('markRead is idempotent: two calls leave exactly ONE receipt', async () => {
    const repo = new InMemoryNewsPostRepository();
    const post = await repo.create(baseInput());

    await repo.markRead(post.id, 'u1');
    await repo.markRead(post.id, 'u1');

    expect(repo.receipts.size).toBe(1);
    expect((await repo.findById(post.id, 'u1'))!.read).toBe(true);
  });

  it('countUnread drops exactly 1 after the first markRead, stays flat after the second', async () => {
    const repo = new InMemoryNewsPostRepository();
    const post = await repo.create(baseInput());

    expect(await repo.countUnread('u1')).toBe(1);
    await repo.markRead(post.id, 'u1');
    expect(await repo.countUnread('u1')).toBe(0);
    await repo.markRead(post.id, 'u1');
    expect(await repo.countUnread('u1')).toBe(0);
  });

  it('countUnread counts only non-archived, unread posts for the user', async () => {
    const repo = new InMemoryNewsPostRepository();
    const p1 = await repo.create(baseInput({ title: 'P1' }));
    await repo.create(baseInput({ title: 'P2' }));
    expect(await repo.countUnread('u1')).toBe(2);

    await repo.setArchived(p1.id, true);
    expect(await repo.countUnread('u1')).toBe(1);
  });
});

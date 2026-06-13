/**
 * #85 — archive() and delete() on InMemoryTicketRepository.
 * Also verifies list() filtering by archivedAt:
 *   - default: excludes archived
 *   - archived: true → returns ONLY archived
 * RED: fails until InMemoryTicketRepository is updated.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';

describe('InMemoryTicketRepository — archivedAt (#85)', () => {
  let repo: InMemoryTicketRepository;

  beforeEach(() => {
    repo = new InMemoryTicketRepository();
  });

  it('create() sets archivedAt: null', async () => {
    const ticket = await repo.create({ subject: 'T1', description: 'd1' });
    expect(ticket.archivedAt).toBeNull();
  });

  it('archive(id) sets archivedAt to a non-null ISO string', async () => {
    const ticket = await repo.create({ subject: 'T2', description: 'd2' });
    const before = new Date().toISOString();
    const archived = await repo.archive(ticket.id);
    const after = new Date().toISOString();

    expect(archived).not.toBeNull();
    expect(archived!.archivedAt).not.toBeNull();
    const ts = archived!.archivedAt!;
    expect(new Date(ts).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(new Date(ts).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
  });

  it('archive(nonexistent) returns null', async () => {
    const result = await repo.archive('nonexistent');
    expect(result).toBeNull();
  });

  // #85 re-review — archive() is idempotent: a second call must NOT re-stamp archivedAt.
  it('archive() is idempotent — re-archiving keeps the original archivedAt', async () => {
    const ticket = await repo.create({ subject: 'T-idem', description: 'd' });
    const first = await repo.archive(ticket.id);
    const firstAt = first!.archivedAt;
    expect(firstAt).not.toBeNull();

    const second = await repo.archive(ticket.id);
    expect(second!.archivedAt).toBe(firstAt);
  });

  it('list() by default excludes archived tickets (archivedAt != null)', async () => {
    const t1 = await repo.create({ subject: 'Active', description: 'd1' });
    const t2 = await repo.create({ subject: 'To Archive', description: 'd2' });
    await repo.archive(t2.id);

    const result = await repo.list({ page: 1, limit: 25 });
    expect(result.total).toBe(1);
    expect(result.data[0]!.id).toBe(t1.id);
  });

  it('list({ archived: true }) returns ONLY archived tickets', async () => {
    const t1 = await repo.create({ subject: 'Active', description: 'd1' });
    const t2 = await repo.create({ subject: 'To Archive', description: 'd2' });
    await repo.archive(t2.id);

    const result = await repo.list({ page: 1, limit: 25, archived: true });
    expect(result.total).toBe(1);
    expect(result.data[0]!.id).toBe(t2.id);
    // Active ticket is NOT in the archived list
    expect(result.data.map((t) => t.id)).not.toContain(t1.id);
  });

  it('delete(id) removes the ticket', async () => {
    const ticket = await repo.create({ subject: 'To Delete', description: 'd' });
    const result = await repo.delete(ticket.id);
    expect(result).toBe(true);
    const found = await repo.getById(ticket.id);
    expect(found).toBeNull();
  });

  it('delete(nonexistent) returns false', async () => {
    const result = await repo.delete('nonexistent');
    expect(result).toBe(false);
  });
});

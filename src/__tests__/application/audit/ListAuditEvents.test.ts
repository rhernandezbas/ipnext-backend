/**
 * Tests for ListAuditEvents use case (SDD #4 Phase 1).
 * Uses InMemoryAuditEventRepository (seed helper for deterministic createdAt).
 */
import { ListAuditEvents } from '@application/use-cases/audit/ListAuditEvents';
import { InMemoryAuditEventRepository } from '@infrastructure/adapters/in-memory/InMemoryAuditEventRepository';

function makeRepo() {
  const repo = new InMemoryAuditEventRepository();
  // Seeded oldest → newest; createdAt controls DESC ordering.
  repo.seed({ actorId: 'u1', actorLogin: 'ana',  method: 'POST',   entityType: 'RbacUser', createdAt: '2026-05-01T10:00:00.000Z' });
  repo.seed({ actorId: 'u1', actorLogin: 'ana',  method: 'DELETE', entityType: 'RbacUser', createdAt: '2026-05-10T10:00:00.000Z' });
  repo.seed({ actorId: 'u2', actorLogin: 'beto', method: 'PUT',    entityType: 'RbacRole', createdAt: '2026-05-20T10:00:00.000Z' });
  repo.seed({ actorId: 'u2', actorLogin: 'beto', method: 'DELETE', entityType: 'RbacRole', createdAt: '2026-05-25T10:00:00.000Z' });
  repo.seed({ actorId: 'u1', actorLogin: 'ana',  method: 'PATCH',  entityType: 'ScheduledTask', createdAt: '2026-05-29T10:00:00.000Z' });
  return repo;
}

describe('ListAuditEvents', () => {
  it('returns a paginated DTO page ordered by createdAt DESC', async () => {
    const useCase = new ListAuditEvents(makeRepo());
    const res = await useCase.execute({ page: 1, pageSize: 50 });

    expect(res).toMatchObject({ total: 5, page: 1, pageSize: 50 });
    expect(res.items).toHaveLength(5);
    // newest first
    expect(res.items[0].createdAt).toBe('2026-05-29T10:00:00.000Z');
    expect(res.items[4].createdAt).toBe('2026-05-01T10:00:00.000Z');
    // DTO shape (no Prisma entity leak)
    expect(res.items[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        actorLogin: 'ana',
        method: 'PATCH',
        entityType: 'ScheduledTask',
        createdAt: '2026-05-29T10:00:00.000Z',
      }),
    );
  });

  it('filters by actorId', async () => {
    const res = await new ListAuditEvents(makeRepo()).execute({ actorId: 'u2' });
    expect(res.total).toBe(2);
    expect(res.items.every(e => e.actorId === 'u2')).toBe(true);
  });

  it('filters by entityType', async () => {
    const res = await new ListAuditEvents(makeRepo()).execute({ entityType: 'RbacRole' });
    expect(res.total).toBe(2);
    expect(res.items.every(e => e.entityType === 'RbacRole')).toBe(true);
  });

  it('filters by method', async () => {
    const res = await new ListAuditEvents(makeRepo()).execute({ method: 'DELETE' });
    expect(res.total).toBe(2);
    expect(res.items.every(e => e.method === 'DELETE')).toBe(true);
  });

  it('filters by date range [from, to] inclusive', async () => {
    const res = await new ListAuditEvents(makeRepo()).execute({
      from: '2026-05-10T00:00:00.000Z',
      to: '2026-05-25T23:59:59.999Z',
    });
    // 2026-05-10, 2026-05-20, 2026-05-25
    expect(res.total).toBe(3);
  });

  it('combines filters (AND semantics)', async () => {
    const res = await new ListAuditEvents(makeRepo()).execute({ actorId: 'u1', method: 'DELETE' });
    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({ actorId: 'u1', method: 'DELETE' });
  });

  it('paginates: total is the full filtered count, items is the page slice', async () => {
    const useCase = new ListAuditEvents(makeRepo());
    const p1 = await useCase.execute({ page: 1, pageSize: 2 });
    const p2 = await useCase.execute({ page: 2, pageSize: 2 });
    const p3 = await useCase.execute({ page: 3, pageSize: 2 });

    expect(p1.total).toBe(5);
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(2);
    expect(p3.items).toHaveLength(1);
    // pages don't overlap, still DESC
    expect(p1.items[0].createdAt).toBe('2026-05-29T10:00:00.000Z');
    expect(p2.items[0].createdAt).toBe('2026-05-20T10:00:00.000Z');
  });

  it('applies sane defaults when page/pageSize are omitted', async () => {
    const res = await new ListAuditEvents(makeRepo()).execute();
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(50);
    expect(res.items).toHaveLength(5);
  });

  it('clamps pageSize to the maximum', async () => {
    const res = await new ListAuditEvents(makeRepo()).execute({ pageSize: 9999 });
    expect(res.pageSize).toBeLessThanOrEqual(200);
  });

  it('returns an empty page when no events exist', async () => {
    const res = await new ListAuditEvents(new InMemoryAuditEventRepository()).execute();
    expect(res).toMatchObject({ total: 0, items: [] });
  });
});

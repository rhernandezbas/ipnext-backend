/**
 * Shared contract tests for AuditEventRepository.
 *
 * Run against InMemory (always) and Prisma (skip-gated on DATABASE_URL_TEST).
 * The factory returns a FRESH, EMPTY repo — `record` is part of the contract.
 */
import type { AuditEventRepository, RecordAuditInput } from '@domain/ports/AuditEventRepository';

const baseInput: RecordAuditInput = {
  actorId: 'u1',
  actorLogin: 'ana',
  method: 'POST',
  path: '/api/admin/rbac/users',
  action: null,
  entityType: 'RbacUser',
  entityId: 'x1',
  beforeJson: { name: 'a' },
  afterJson: { name: 'b' },
  statusCode: 201,
  errorMessage: null,
  ip: '1.2.3.4',
};

export function runAuditEventContractTests(
  makeRepo: () => Promise<AuditEventRepository>,
): void {
  describe('record', () => {
    it('persists and returns the event with a generated id + createdAt', async () => {
      const repo = await makeRepo();
      const ev = await repo.record(baseInput);
      expect(typeof ev.id).toBe('string');
      expect(ev.id.length).toBeGreaterThan(0);
      expect(typeof ev.createdAt).toBe('string');
      expect(ev.createdAt.length).toBeGreaterThan(0);
      expect(ev).toMatchObject({ actorLogin: 'ana', method: 'POST', statusCode: 201, entityType: 'RbacUser' });
    });
  });

  describe('list', () => {
    it('returns an empty page for a fresh repo', async () => {
      const repo = await makeRepo();
      const page = await repo.list({ page: 1, pageSize: 10 });
      expect(page).toMatchObject({ total: 0, page: 1, pageSize: 10 });
      expect(page.items).toEqual([]);
    });

    it('returns recorded events with total and respects pageSize', async () => {
      const repo = await makeRepo();
      await repo.record({ ...baseInput, method: 'POST' });
      await repo.record({ ...baseInput, method: 'PUT' });
      await repo.record({ ...baseInput, method: 'DELETE' });

      const page = await repo.list({ page: 1, pageSize: 2 });
      expect(page.total).toBe(3);
      expect(page.items).toHaveLength(2);
    });

    it('filters by method', async () => {
      const repo = await makeRepo();
      await repo.record({ ...baseInput, method: 'POST' });
      await repo.record({ ...baseInput, method: 'DELETE' });

      const page = await repo.list({ method: 'DELETE', page: 1, pageSize: 10 });
      expect(page.total).toBe(1);
      expect(page.items[0].method).toBe('DELETE');
    });
  });
}

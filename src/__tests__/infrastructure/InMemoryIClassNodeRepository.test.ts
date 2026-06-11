/**
 * Contract tests for IClassNodeRepository (via the in-memory adapter).
 * Covers: list filters (active/selectable), upsert by nodeId (create/update/
 * reactivate), markInactiveExcept. Mirrors the SoType repo contract, keyed by nodeId.
 */
import { InMemoryIClassNodeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassNodeRepository';

function setup() {
  return new InMemoryIClassNodeRepository();
}

describe('InMemoryIClassNodeRepository', () => {
  describe('upsertByNodeId', () => {
    it('new nodeId → created, row is active', async () => {
      const repo = setup();
      const { status } = await repo.upsertByNodeId({
        nodeId: 100,
        code: 'Mercedes',
        description: 'Mercedes',
        selectable: true,
      });
      expect(status).toBe('created');
      const all = await repo.list();
      expect(all).toHaveLength(1);
      expect(all[0].active).toBe(true);
      expect(all[0].nodeId).toBe(100);
      expect(all[0].id).toEqual(expect.any(String));
    });

    it('existing active nodeId → updated, updates code/description/selectable', async () => {
      const repo = setup();
      await repo.upsertByNodeId({ nodeId: 100, code: 'Old', description: 'Old', selectable: true });
      const { status } = await repo.upsertByNodeId({
        nodeId: 100,
        code: 'New',
        description: 'New desc',
        selectable: false,
      });
      expect(status).toBe('updated');
      const all = await repo.list();
      expect(all).toHaveLength(1);
      expect(all[0].code).toBe('New');
      expect(all[0].description).toBe('New desc');
      expect(all[0].selectable).toBe(false);
    });

    it('previously inactive nodeId → reactivated', async () => {
      const repo = setup();
      await repo.upsertByNodeId({ nodeId: 100, code: 'M', description: 'M', selectable: true });
      await repo.markInactiveExcept([]); // deactivate it
      const { status } = await repo.upsertByNodeId({
        nodeId: 100,
        code: 'M',
        description: 'M',
        selectable: true,
      });
      expect(status).toBe('reactivated');
      const active = await repo.list({ active: true });
      expect(active).toHaveLength(1);
    });
  });

  describe('markInactiveExcept', () => {
    it('deactivates rows whose nodeId is not present, returns the count', async () => {
      const repo = setup();
      await repo.upsertByNodeId({ nodeId: 1, code: 'A', description: 'A', selectable: true });
      await repo.upsertByNodeId({ nodeId: 2, code: 'B', description: 'B', selectable: true });
      await repo.upsertByNodeId({ nodeId: 3, code: 'C', description: 'C', selectable: true });

      const deactivated = await repo.markInactiveExcept([1, 2]);
      expect(deactivated).toBe(1);

      const inactive = await repo.list({ active: false });
      expect(inactive).toHaveLength(1);
      expect(inactive[0].nodeId).toBe(3);
    });

    it('idempotent — does not re-count already-inactive rows', async () => {
      const repo = setup();
      await repo.upsertByNodeId({ nodeId: 1, code: 'A', description: 'A', selectable: true });
      await repo.markInactiveExcept([]);
      const second = await repo.markInactiveExcept([]);
      expect(second).toBe(0);
    });
  });

  describe('list filters', () => {
    async function seed(repo: InMemoryIClassNodeRepository) {
      await repo.upsertByNodeId({ nodeId: 1, code: 'A', description: 'A', selectable: true });
      await repo.upsertByNodeId({ nodeId: 2, code: 'B', description: 'B', selectable: true });
      await repo.upsertByNodeId({ nodeId: 3, code: 'Main', description: 'Main', selectable: false });
      await repo.markInactiveExcept([1, 2, 3]); // nothing deactivated, all present
    }

    it('no filter → all', async () => {
      const repo = setup();
      await seed(repo);
      expect(await repo.list()).toHaveLength(3);
    });

    it('selectable=true → excludes grouping nodes', async () => {
      const repo = setup();
      await seed(repo);
      const items = await repo.list({ selectable: true });
      expect(items).toHaveLength(2);
      expect(items.every(i => i.selectable)).toBe(true);
    });

    it('active=true & selectable=true → combined filter', async () => {
      const repo = setup();
      await seed(repo);
      await repo.markInactiveExcept([1, 3]); // deactivate node 2 (selectable)
      const items = await repo.list({ active: true, selectable: true });
      expect(items).toHaveLength(1);
      expect(items[0].nodeId).toBe(1);
    });
  });

  describe('getById', () => {
    it('returns the node by uuid, null for unknown', async () => {
      const repo = setup();
      await repo.upsertByNodeId({ nodeId: 1, code: 'A', description: 'A', selectable: true });
      const [node] = await repo.list();
      expect(await repo.getById(node.id)).toMatchObject({ nodeId: 1, code: 'A' });
      expect(await repo.getById('nope')).toBeNull();
    });
  });
});

import { InMemoryIClassStatusCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassStatusCatalogRepository';

describe('InMemoryIClassStatusCatalogRepository', () => {
  function makeRepo() {
    return new InMemoryIClassStatusCatalogRepository();
  }

  describe('upsertByStatusCode', () => {
    it('creates a new entry with tracked=false, displayLabel=null, color=null', async () => {
      const repo = makeRepo();
      const result = await repo.upsertByStatusCode({ statusCode: '12', iclassLabel: 'Em Análise' });
      expect(result.status).toBe('created');
      const entry = await repo.getByStatusCode('12');
      expect(entry).not.toBeNull();
      expect(entry!.statusCode).toBe('12');
      expect(entry!.iclassLabel).toBe('Em Análise');
      expect(entry!.displayLabel).toBeNull();
      expect(entry!.color).toBeNull();
      expect(entry!.tracked).toBe(false);
    });

    it('returns "updated" and refreshes iclassLabel/lastSyncedAt on duplicate statusCode', async () => {
      const repo = makeRepo();
      await repo.upsertByStatusCode({ statusCode: '12', iclassLabel: 'Em Análise' });
      // Manually configure the entry
      await repo.update('12', { displayLabel: 'En análisis', color: '#FFAA00', tracked: true });

      const t0 = (await repo.getByStatusCode('12'))!.lastSyncedAt;

      // Small delay to ensure lastSyncedAt differs
      await new Promise(r => setTimeout(r, 2));

      const result = await repo.upsertByStatusCode({ statusCode: '12', iclassLabel: 'Em Análise (alt)' });
      expect(result.status).toBe('updated');

      const entry = await repo.getByStatusCode('12');
      expect(entry!.iclassLabel).toBe('Em Análise (alt)');
      // Config preserved
      expect(entry!.displayLabel).toBe('En análisis');
      expect(entry!.color).toBe('#FFAA00');
      expect(entry!.tracked).toBe(true);
      // lastSyncedAt updated
      expect(entry!.lastSyncedAt.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    });
  });

  describe('update (partial patch)', () => {
    it('sets only tracked when only tracked provided', async () => {
      const repo = makeRepo();
      await repo.upsertByStatusCode({ statusCode: '3', iclassLabel: 'Agendada' });
      const updated = await repo.update('3', { tracked: true });
      expect(updated).not.toBeNull();
      expect(updated!.tracked).toBe(true);
      expect(updated!.displayLabel).toBeNull();
      expect(updated!.color).toBeNull();
    });

    it('sets displayLabel and color without affecting tracked', async () => {
      const repo = makeRepo();
      await repo.upsertByStatusCode({ statusCode: '3', iclassLabel: 'Agendada' });
      await repo.update('3', { tracked: true });
      const updated = await repo.update('3', { displayLabel: 'Programada', color: '#00AAFF' });
      expect(updated!.displayLabel).toBe('Programada');
      expect(updated!.color).toBe('#00AAFF');
      expect(updated!.tracked).toBe(true); // unchanged
    });

    it('returns null for unknown statusCode', async () => {
      const repo = makeRepo();
      const result = await repo.update('999', { tracked: true });
      expect(result).toBeNull();
    });

    it('can clear displayLabel by passing null', async () => {
      const repo = makeRepo();
      await repo.upsertByStatusCode({ statusCode: '3', iclassLabel: 'Agendada' });
      await repo.update('3', { displayLabel: 'Programada' });
      const updated = await repo.update('3', { displayLabel: null });
      expect(updated!.displayLabel).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all entries', async () => {
      const repo = makeRepo();
      await repo.upsertByStatusCode({ statusCode: '7', iclassLabel: 'Concluida' });
      await repo.upsertByStatusCode({ statusCode: '3', iclassLabel: 'Agendada' });
      const items = await repo.list();
      expect(items).toHaveLength(2);
    });

    it('returns empty array when catalog is empty', async () => {
      const repo = makeRepo();
      expect(await repo.list()).toEqual([]);
    });
  });

  describe('findManyByStatusCodes', () => {
    it('returns only existing entries, silently omitting missing codes', async () => {
      const repo = makeRepo();
      await repo.upsertByStatusCode({ statusCode: '3', iclassLabel: 'Agendada' });
      await repo.upsertByStatusCode({ statusCode: '7', iclassLabel: 'Concluida' });

      const result = await repo.findManyByStatusCodes(['3', '7', '999']);
      expect(result).toHaveLength(2);
      const codes = result.map(r => r.statusCode).sort();
      expect(codes).toEqual(['3', '7']);
    });

    it('returns empty array when none match', async () => {
      const repo = makeRepo();
      const result = await repo.findManyByStatusCodes(['999']);
      expect(result).toEqual([]);
    });
  });
});

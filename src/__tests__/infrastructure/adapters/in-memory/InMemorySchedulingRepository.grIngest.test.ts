import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';

/**
 * Formal coverage for the Gestión Real installation-ingest extensions
 * (`findTaskByGrOrdenId` + `listNeedsReview`). Implementations landed with the
 * port additions; these tests pin the contract.
 */
describe('InMemorySchedulingRepository — GR ingest extensions', () => {
  describe('findTaskByGrOrdenId', () => {
    it('returns the task previously created with that GR order id', async () => {
      const repo = new InMemorySchedulingRepository();
      const created = await repo.createTask({
        title: 'Instalación 551',
        priority: 'normal',
        estimatedHours: 2,
        category: 'installation',
        projectId: 'p-fiber',
        grOrdenId: '551',
      } as any);

      const found = await repo.findTaskByGrOrdenId('551');

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.grOrdenId).toBe('551');
    });

    it('returns null when no task carries that GR order id', async () => {
      const repo = new InMemorySchedulingRepository();

      const found = await repo.findTaskByGrOrdenId('does-not-exist');

      expect(found).toBeNull();
    });
  });

  describe('listNeedsReview', () => {
    it('returns only GR-ingested tasks left unclassified (grOrdenId set, projectId null)', async () => {
      const repo = new InMemorySchedulingRepository();

      // Needs-review: ingested but no project.
      const needsReview = await repo.createTask({
        title: '[REVISAR - Logística] Instalación',
        priority: 'normal',
        estimatedHours: 2,
        category: 'installation',
        projectId: null,
        grOrdenId: '900',
      } as any);

      // Classified fiber: ingested WITH project → excluded.
      await repo.createTask({
        title: 'Instalación fibra',
        priority: 'normal',
        estimatedHours: 2,
        category: 'installation',
        projectId: 'p-fiber',
        grOrdenId: '901',
      } as any);

      // Manual task with null project but NO grOrdenId → excluded.
      await repo.createTask({
        title: 'Tarea manual',
        priority: 'normal',
        estimatedHours: 1,
        category: 'other',
        projectId: null,
      } as any);

      const result = await repo.listNeedsReview();

      expect(result.map(t => t.id)).toEqual([needsReview.id]);
      expect(result).toHaveLength(1);
      expect(result[0].grOrdenId).toBe('900');
      expect(result[0].projectId).toBeNull();
    });

    it('returns an empty array when nothing needs review', async () => {
      const repo = new InMemorySchedulingRepository();

      const result = await repo.listNeedsReview();

      expect(result).toEqual([]);
    });
  });
});

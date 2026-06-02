import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';

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

  describe('getInitialStage', () => {
    it('returns the lowest-order stage of the workflow', async () => {
      const stageRepo = new InMemoryStageRepository();
      const repo = new InMemorySchedulingRepository(stageRepo);
      // Seed an installation workflow whose stages are NOT named "Pendiente".
      const wfId = 'wf-install';
      const confirmado = await stageRepo.add(wfId, { name: 'Confirmado', code: 'confirmado', category: 'enProgreso', order: 1 });
      const nuevo = await stageRepo.add(wfId, { name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 0 });
      await stageRepo.add(wfId, { name: 'Enviar a IClass', code: 'send_to_iclass', category: 'enProgreso', order: 5 });

      const initial = await repo.getInitialStage(wfId);

      expect(initial).not.toBeNull();
      expect(initial!.id).toBe(nuevo.id);
      expect(initial!.name).toBe('Nuevo');
      expect(initial!.order).toBe(0);
      // Not the higher-order one.
      expect(initial!.id).not.toBe(confirmado.id);
    });

    it('returns null for an unknown workflow', async () => {
      const stageRepo = new InMemoryStageRepository();
      const repo = new InMemorySchedulingRepository(stageRepo);
      await stageRepo.add('wf-other', { name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 0 });

      const initial = await repo.getInitialStage('wf-does-not-exist');

      expect(initial).toBeNull();
    });

    it('returns null when no stage repo is injected', async () => {
      const repo = new InMemorySchedulingRepository();

      const initial = await repo.getInitialStage('wf-any');

      expect(initial).toBeNull();
    });
  });
});

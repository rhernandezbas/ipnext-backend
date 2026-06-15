/**
 * Tests for InMemorySchedulingRepository.setIClassStatus and iclassStatus resolution.
 * Verifies that:
 * 1. setIClassStatus persists code + at on the task
 * 2. The task read-path resolves iclassStatus by catalog lookup (label/color/tracked)
 * 3. iclassStatus is null when no code or no matching catalog entry
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryIClassStatusCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassStatusCatalogRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { Stage } from '@domain/entities/workflow';

describe('InMemorySchedulingRepository — setIClassStatus + iclassStatus resolution', () => {
  function makeRepo(statusCatalog?: InMemoryIClassStatusCatalogRepository) {
    return new InMemorySchedulingRepository(undefined, undefined, statusCatalog);
  }

  it('setIClassStatus persists the statusCode on the task', async () => {
    const repo = makeRepo();
    const task = repo.seedTask({ id: 't1' });
    const at = new Date('2026-06-01T10:00:00Z');
    await repo.setIClassStatus(task.id, '7', at);

    const found = await repo.getTask(task.id);
    expect(found).not.toBeNull();
    expect(found!.iclassStatusCode).toBe('7');
    expect(found!.iclassStatusUpdatedAt).toBe(at.toISOString());
  });

  it('iclassStatus is null when task has no iclassStatusCode', async () => {
    const catalog = new InMemoryIClassStatusCatalogRepository();
    await catalog.upsertByStatusCode({ statusCode: '7', iclassLabel: 'Concluida' });
    const repo = makeRepo(catalog);
    repo.seedTask({ id: 't2' });

    const found = await repo.getTask('t2');
    expect(found!.iclassStatus).toBeNull();
  });

  it('resolves iclassStatus from catalog using effectiveLabel (displayLabel when set)', async () => {
    const catalog = new InMemoryIClassStatusCatalogRepository();
    await catalog.upsertByStatusCode({ statusCode: '7', iclassLabel: 'Concluida' });
    await catalog.update('7', { displayLabel: 'Cerrada', color: '#00FF00', tracked: true });

    const repo = makeRepo(catalog);
    repo.seedTask({ id: 't3' });
    await repo.setIClassStatus('t3', '7', new Date());

    const found = await repo.getTask('t3');
    expect(found!.iclassStatus).toEqual({
      code: '7',
      label: 'Cerrada',
      color: '#00FF00',
      tracked: true,
    });
  });

  it('resolves iclassStatus using iclassLabel when displayLabel is null', async () => {
    const catalog = new InMemoryIClassStatusCatalogRepository();
    await catalog.upsertByStatusCode({ statusCode: '3', iclassLabel: 'Agendada' });

    const repo = makeRepo(catalog);
    repo.seedTask({ id: 't4' });
    await repo.setIClassStatus('t4', '3', new Date());

    const found = await repo.getTask('t4');
    expect(found!.iclassStatus).toEqual({
      code: '3',
      label: 'Agendada',
      color: null,
      tracked: false,
    });
  });

  it('iclassStatus is null when code is set but catalog has no matching entry', async () => {
    const catalog = new InMemoryIClassStatusCatalogRepository();
    const repo = makeRepo(catalog);
    repo.seedTask({ id: 't5' });
    await repo.setIClassStatus('t5', '999', new Date());

    const found = await repo.getTask('t5');
    expect(found!.iclassStatusCode).toBe('999');
    expect(found!.iclassStatus).toBeNull();
  });

  it('setIClassStatus is a no-op when task does not exist', async () => {
    const repo = makeRepo();
    // Should NOT throw
    await expect(repo.setIClassStatus('non-existent-id', '7', new Date())).resolves.toBeUndefined();
  });
});

describe('InMemorySchedulingRepository — moveTaskToStageIfForward workflow guard', () => {
  // Workflow A stages (low order) and workflow B stages (high order). The forward-only
  // `order` comparison is per-workflow; comparing across workflows is meaningless, and a
  // cross-workflow move would point the task at a Stage of ANOTHER workflow (inconsistent).
  const WF_A_LOW: Stage  = { id: 'a-low',  workflowId: 'wf-a', name: 'A low',  code: 'a_low',  category: 'nuevo',      order: 1, color: null };
  const WF_A_HIGH: Stage = { id: 'a-high', workflowId: 'wf-a', name: 'A high', code: 'a_high', category: 'enProgreso', order: 9, color: null };
  const WF_B_HIGH: Stage = { id: 'b-high', workflowId: 'wf-b', name: 'B high', code: 'b_high', category: 'enProgreso', order: 9, color: null };
  const WF_B_LOW: Stage  = { id: 'b-low',  workflowId: 'wf-b', name: 'B low',  code: 'b_low',  category: 'nuevo',      order: 1, color: null };

  function makeRepoWithStages() {
    const stages = new InMemoryStageRepository();
    stages.addDirect(WF_A_LOW);
    stages.addDirect(WF_A_HIGH);
    stages.addDirect(WF_B_HIGH);
    stages.addDirect(WF_B_LOW);
    const repo = new InMemorySchedulingRepository(stages);
    return { repo, stages };
  }

  it('does NOT move when the target stage belongs to a DIFFERENT workflow (even if target order is higher)', async () => {
    const { repo } = makeRepoWithStages();
    // Task currently in workflow A, low order.
    repo.seedTask({ id: 't1', stageId: WF_A_LOW.id });

    // Target is in workflow B with a HIGHER order — a naive `order` comparison would move it.
    const result = await repo.moveTaskToStageIfForward('t1', WF_B_HIGH.id);

    expect(result).toEqual({ moved: false });
    const task = await repo.getTask('t1');
    expect(task!.stageId).toBe(WF_A_LOW.id); // unchanged — never crosses workflows
  });

  it('still moves forward within the SAME workflow (intra-workflow behaviour intact)', async () => {
    const { repo } = makeRepoWithStages();
    repo.seedTask({ id: 't2', stageId: WF_A_LOW.id });

    const result = await repo.moveTaskToStageIfForward('t2', WF_A_HIGH.id);

    expect(result).toEqual({ moved: true });
    const task = await repo.getTask('t2');
    expect(task!.stageId).toBe(WF_A_HIGH.id);
  });

  it('still refuses to retreat within the SAME workflow (forward-only policy intact)', async () => {
    const { repo } = makeRepoWithStages();
    repo.seedTask({ id: 't3', stageId: WF_A_HIGH.id });

    const result = await repo.moveTaskToStageIfForward('t3', WF_A_LOW.id);

    expect(result).toEqual({ moved: false });
    const task = await repo.getTask('t3');
    expect(task!.stageId).toBe(WF_A_HIGH.id);
  });
});

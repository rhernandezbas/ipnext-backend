/**
 * TDD — InMemorySchedulingRepository: getStageByCode + listTasksInIClassStage by code (T-06)
 * REQ-CODE-4, REQ-LIST-ICLASS-1
 */
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { Stage } from '@domain/entities/workflow';

const STAGE_IClass_WF1: Stage = {
  id: 'stage-iclass-wf1',
  workflowId: 'wf-1',
  name: 'Registrado en IClass',
  code: 'registered_in_iclass',
  category: 'enProgreso',
  order: 6,
  color: null,
};

const STAGE_IClass_WF2: Stage = {
  id: 'stage-iclass-wf2',
  workflowId: 'wf-2',
  name: 'Registrado en IClass',  // mismo name, distinto workflowId
  code: 'registered_in_iclass',
  category: 'enProgreso',
  order: 6,
  color: null,
};

function setup() {
  const stageRepo = new InMemoryStageRepository();
  stageRepo.addDirect(STAGE_IClass_WF1);
  stageRepo.addDirect(STAGE_IClass_WF2);
  const repo = new InMemorySchedulingRepository(stageRepo);
  return { repo, stageRepo };
}

describe('InMemorySchedulingRepository — getStageByCode (T-06)', () => {
  it('returns the stage matching (code, workflowId)', async () => {
    const { repo } = setup();
    const stage = await repo.getStageByCode('registered_in_iclass', 'wf-1');
    expect(stage).not.toBeNull();
    expect(stage!.id).toBe('stage-iclass-wf1');
    expect(stage!.code).toBe('registered_in_iclass');
  });

  it('resolves to the correct workflow when codes collide across workflows', async () => {
    const { repo } = setup();
    const s1 = await repo.getStageByCode('registered_in_iclass', 'wf-1');
    const s2 = await repo.getStageByCode('registered_in_iclass', 'wf-2');
    expect(s1!.id).toBe('stage-iclass-wf1');
    expect(s2!.id).toBe('stage-iclass-wf2');
  });

  it('returns null when code does not exist in the given workflow', async () => {
    const { repo } = setup();
    const result = await repo.getStageByCode('nonexistent_code', 'wf-1');
    expect(result).toBeNull();
  });

  it('returns null when workflowId does not match', async () => {
    const { repo } = setup();
    const result = await repo.getStageByCode('registered_in_iclass', 'wf-nope');
    expect(result).toBeNull();
  });
});

describe('InMemorySchedulingRepository — listTasksInIClassStage by code (T-06)', () => {
  it('filters tasks by stage code (not by name) — rename-safe', async () => {
    const stageRepo = new InMemoryStageRepository();
    // Stage with a DIFFERENT name but SAME code → tasks in this stage should appear
    const renamedStage: Stage = {
      id: 'stage-renamed',
      workflowId: 'wf-rename',
      name: 'Nombre cambiado por usuario',  // renamed!
      code: 'registered_in_iclass',          // code stable
      category: 'enProgreso',
      order: 3,
      color: null,
    };
    stageRepo.addDirect(renamedStage);
    const repo = new InMemorySchedulingRepository(stageRepo);

    // Seed a task in that stage
    repo.seedTask({
      id: 'task-in-renamed-stage',
      stageId: 'stage-renamed',
    });

    const tasks = await repo.listTasksInIClassStage('registered_in_iclass');
    expect(tasks.length).toBeGreaterThan(0);
    const ids = tasks.map((t: { id: string }) => t.id);
    expect(ids).toContain('task-in-renamed-stage');
  });

  it('returns empty array when no stage matches the code', async () => {
    const { repo } = setup();
    const tasks = await repo.listTasksInIClassStage('no_such_code');
    expect(tasks).toEqual([]);
  });
});

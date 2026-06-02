import { InMemoryWorkflowRepository } from '../../infrastructure/adapters/in-memory/InMemoryWorkflowRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { GetWorkflow } from '../../application/use-cases/GetWorkflow';
import { CreateWorkflow } from '../../application/use-cases/CreateWorkflow';
import { UpdateWorkflow } from '../../application/use-cases/UpdateWorkflow';
import { DeleteWorkflow } from '../../application/use-cases/DeleteWorkflow';
import { AddStageToWorkflow } from '../../application/use-cases/AddStageToWorkflow';
import { RemoveStageFromWorkflow } from '../../application/use-cases/RemoveStageFromWorkflow';
import { ReorderStages } from '../../application/use-cases/ReorderStages';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import {
  WorkflowNameConflictError,
  WorkflowNotFoundError,
  WorkflowInUseError,
  DefaultWorkflowProtectedError,
  StageNameConflictError,
  StageNotFoundError,
  StageInUseError,
  ReorderSetMismatchError,
  TaskNotFoundError,
} from '../../domain/errors/scheduling';

function makeRepos() {
  const wfRepo = new InMemoryWorkflowRepository();
  const stageRepo = new InMemoryStageRepository();
  const taskRepo = new InMemorySchedulingRepository(stageRepo);
  return { wfRepo, taskRepo, stageRepo };
}

// ─── GetWorkflow ─────────────────────────────────────────────────────────────

describe('GetWorkflow', () => {
  it('returns workflow by id', async () => {
    const { wfRepo } = makeRepos();
    const created = await wfRepo.create({ name: 'WF1', description: null, stages: [] });
    const uc = new GetWorkflow(wfRepo);
    const result = await uc.execute(created.id);
    expect(result.name).toBe('WF1');
  });

  it('throws WorkflowNotFoundError for unknown id', async () => {
    const { wfRepo } = makeRepos();
    const uc = new GetWorkflow(wfRepo);
    await expect(uc.execute('nonexistent')).rejects.toThrow(WorkflowNotFoundError);
  });
});

// ─── CreateWorkflow ───────────────────────────────────────────────────────────

describe('CreateWorkflow', () => {
  it('creates workflow with stages', async () => {
    const { wfRepo } = makeRepos();
    const uc = new CreateWorkflow(wfRepo);
    const result = await uc.execute({
      name: 'My Workflow',
      stages: [{ name: 'Nuevo', category: 'nuevo', order: 0 }],
    });
    expect(result.name).toBe('My Workflow');
    expect(result.stages).toHaveLength(1);
  });

  it('throws WorkflowNameConflictError on duplicate name', async () => {
    const { wfRepo } = makeRepos();
    const uc = new CreateWorkflow(wfRepo);
    await uc.execute({ name: 'WF1' });
    await expect(uc.execute({ name: 'WF1' })).rejects.toThrow(WorkflowNameConflictError);
  });

  it('creates workflow with empty stages array', async () => {
    const { wfRepo } = makeRepos();
    const uc = new CreateWorkflow(wfRepo);
    const result = await uc.execute({ name: 'Empty WF', stages: [] });
    expect(result.stages).toHaveLength(0);
  });
});

// ─── UpdateWorkflow ───────────────────────────────────────────────────────────

describe('UpdateWorkflow', () => {
  it('updates name', async () => {
    const { wfRepo } = makeRepos();
    const created = await wfRepo.create({ name: 'OldName', description: null, stages: [] });
    const uc = new UpdateWorkflow(wfRepo);
    const updated = await uc.execute(created.id, { name: 'NewName' });
    expect(updated.name).toBe('NewName');
  });

  it('throws WorkflowNotFoundError for unknown id', async () => {
    const { wfRepo } = makeRepos();
    const uc = new UpdateWorkflow(wfRepo);
    await expect(uc.execute('bad-id', { name: 'X' })).rejects.toThrow(WorkflowNotFoundError);
  });

  it('throws WorkflowNameConflictError on name collision', async () => {
    const { wfRepo } = makeRepos();
    const uc = new UpdateWorkflow(wfRepo);
    await wfRepo.create({ name: 'WF-A', description: null, stages: [] });
    const b = await wfRepo.create({ name: 'WF-B', description: null, stages: [] });
    await expect(uc.execute(b.id, { name: 'WF-A' })).rejects.toThrow(WorkflowNameConflictError);
  });
});

// ─── DeleteWorkflow ───────────────────────────────────────────────────────────

describe('DeleteWorkflow', () => {
  it('deletes a workflow that has no tasks', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({ name: 'Deletable', description: null, stages: [] });
    const uc = new DeleteWorkflow(wfRepo, stageRepo);
    await expect(uc.execute(wf.id)).resolves.toBeUndefined();
    await expect(wfRepo.getById(wf.id)).resolves.toBeNull();
  });

  it('throws WorkflowNotFoundError for unknown id', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const uc = new DeleteWorkflow(wfRepo, stageRepo);
    await expect(uc.execute('nope')).rejects.toThrow(WorkflowNotFoundError);
  });

  it('throws DefaultWorkflowProtectedError for "Default" workflow', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({ name: 'Default', description: null, stages: [] });
    const uc = new DeleteWorkflow(wfRepo, stageRepo);
    await expect(uc.execute(wf.id)).rejects.toThrow(DefaultWorkflowProtectedError);
  });

  it('throws WorkflowInUseError when stages have tasks', async () => {
    // Set up a dedicated wf + stageRepo that reports 1 task using the stage
    const wf2Repo = new InMemoryWorkflowRepository();
    const createdWf = await wf2Repo.create({
      name: 'InUse2',
      description: null,
      stages: [{ name: 'S1', code: 's1', category: 'nuevo', order: 0 }],
    });
    const stageId = createdWf.stages[0].id;

    // stageRepo that always reports 1 task using any stage
    const mockStageRepo = new InMemoryStageRepository(() => [stageId]);
    mockStageRepo.addDirect(createdWf.stages[0]);

    const uc2 = new DeleteWorkflow(wf2Repo, mockStageRepo);
    await expect(uc2.execute(createdWf.id)).rejects.toThrow(WorkflowInUseError);
  });
});

// ─── AddStageToWorkflow ───────────────────────────────────────────────────────

describe('AddStageToWorkflow', () => {
  it('adds a stage to a workflow', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({ name: 'WF', description: null, stages: [] });
    const uc = new AddStageToWorkflow(wfRepo, stageRepo);
    const stage = await uc.execute(wf.id, { name: 'Nuevo', category: 'nuevo', order: 0 });
    expect(stage.name).toBe('Nuevo');
    expect(stage.workflowId).toBe(wf.id);
  });

  it('throws WorkflowNotFoundError for unknown workflow', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const uc = new AddStageToWorkflow(wfRepo, stageRepo);
    await expect(uc.execute('nope', { name: 'S', category: 'nuevo', order: 0 })).rejects.toThrow(WorkflowNotFoundError);
  });

  it('throws StageNameConflictError for duplicate stage name in workflow', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({ name: 'WF', description: null, stages: [{ name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 0 }] });
    const uc = new AddStageToWorkflow(wfRepo, stageRepo);
    await expect(uc.execute(wf.id, { name: 'Nuevo', category: 'nuevo', order: 1 })).rejects.toThrow(StageNameConflictError);
  });

  // T-23: code autogeneration (REQ-CODE-1, REQ-CODE-2)
  it('T-23: autogenerates code slug from name', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({ name: 'WF', description: null, stages: [] });
    const uc = new AddStageToWorkflow(wfRepo, stageRepo);
    const stage = await uc.execute(wf.id, { name: 'En Revision', category: 'nuevo', order: 0 });
    expect(stage.code).toBe('en_revision');
  });

  it('T-23: disambiguates code with suffix when slug collision within workflow', async () => {
    // Scenario: existing stage has code 'en_revision' (from name 'En Revision')
    // A new stage named 'En-Revision' also slugifies to 'en_revision' → gets 'en_revision_2'
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({ name: 'WF', description: null, stages: [{ name: 'En Revision', code: 'en_revision', category: 'nuevo', order: 0 }] });
    wf.stages.forEach(s => stageRepo.addDirect(s));
    const uc = new AddStageToWorkflow(wfRepo, stageRepo);
    // 'En-Revision' slugifies to 'en_revision' which collides → should get 'en_revision_2'
    const stage = await uc.execute(wf.id, { name: 'En-Revision', category: 'nuevo', order: 1 });
    expect(stage.code).toBe('en_revision_2');
  });

  it('T-23: ignores any code in input — autogenerates its own (REQ-CODE-1 immutability)', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({ name: 'WF', description: null, stages: [] });
    const uc = new AddStageToWorkflow(wfRepo, stageRepo);
    // even if execute() signature doesn't accept code, any code field in the input object is ignored
    const stage = await uc.execute(wf.id, { name: 'Mi Stage', category: 'nuevo', order: 0 });
    // code must be the slug of the name, NOT any externally provided value
    expect(stage.code).toBe('mi_stage');
  });
});

// ─── RemoveStageFromWorkflow ──────────────────────────────────────────────────

describe('RemoveStageFromWorkflow', () => {
  it('removes an unused stage', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({ name: 'WF', description: null, stages: [] });
    const stage = await stageRepo.add(wf.id, { name: 'S', code: 's', category: 'nuevo', order: 0 });
    const uc = new RemoveStageFromWorkflow(stageRepo);
    await expect(uc.execute(wf.id, stage.id)).resolves.toBeUndefined();
  });

  it('throws StageNotFoundError for unknown stage', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({ name: 'WF', description: null, stages: [] });
    const uc = new RemoveStageFromWorkflow(stageRepo);
    await expect(uc.execute(wf.id, 'nope')).rejects.toThrow(StageNotFoundError);
  });

  it('throws StageInUseError when stage has tasks', async () => {
    const { wfRepo, stageRepo: origStageRepo } = makeRepos();
    const wf = await wfRepo.create({ name: 'WF', description: null, stages: [] });
    const stage = await origStageRepo.add(wf.id, { name: 'S', code: 's', category: 'nuevo', order: 0 });

    const inUseStageRepo = new InMemoryStageRepository(() => [stage.id]);
    inUseStageRepo.addDirect(stage);

    const uc = new RemoveStageFromWorkflow(inUseStageRepo);
    await expect(uc.execute(wf.id, stage.id)).rejects.toThrow(StageInUseError);
  });
});

// ─── ReorderStages ───────────────────────────────────────────────────────────

describe('ReorderStages', () => {
  it('happy path: reorders stages correctly', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({
      name: 'WF',
      description: null,
      stages: [
        { name: 'A', code: 'a', category: 'nuevo', order: 0 },
        { name: 'B', code: 'b', category: 'nuevo', order: 1 },
        { name: 'C', code: 'c', category: 'hecho', order: 2 },
      ],
    });
    // Sync stage repo from wf stages
    wf.stages.forEach(s => stageRepo.addDirect(s));

    const uc = new ReorderStages(wfRepo, stageRepo);
    const ids = wf.stages.map(s => s.id);
    // Reverse the order
    await uc.execute(wf.id, [ids[2], ids[1], ids[0]]);
    const updated = await stageRepo.listByWorkflow(wf.id);
    expect(updated[0].id).toBe(ids[2]);
    expect(updated[0].order).toBe(0);
  });

  it('throws WorkflowNotFoundError for unknown workflow', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const uc = new ReorderStages(wfRepo, stageRepo);
    await expect(uc.execute('nope', ['id1'])).rejects.toThrow(WorkflowNotFoundError);
  });

  it('throws ReorderSetMismatchError for missing id', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({
      name: 'WF',
      description: null,
      stages: [
        { name: 'A', code: 'a', category: 'nuevo', order: 0 },
        { name: 'B', code: 'b', category: 'nuevo', order: 1 },
      ],
    });
    wf.stages.forEach(s => stageRepo.addDirect(s));
    const uc = new ReorderStages(wfRepo, stageRepo);
    // Only send one ID
    await expect(uc.execute(wf.id, [wf.stages[0].id])).rejects.toThrow(ReorderSetMismatchError);
  });

  it('throws ReorderSetMismatchError for extra id', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({ name: 'WF', description: null, stages: [{ name: 'A', code: 'a', category: 'nuevo', order: 0 }] });
    wf.stages.forEach(s => stageRepo.addDirect(s));
    const uc = new ReorderStages(wfRepo, stageRepo);
    await expect(uc.execute(wf.id, [wf.stages[0].id, 'extra-id'])).rejects.toThrow(ReorderSetMismatchError);
  });

  it('throws ReorderSetMismatchError for duplicate ids', async () => {
    const { wfRepo, stageRepo } = makeRepos();
    const wf = await wfRepo.create({
      name: 'WF',
      description: null,
      stages: [
        { name: 'A', code: 'a', category: 'nuevo', order: 0 },
        { name: 'B', code: 'b', category: 'nuevo', order: 1 },
      ],
    });
    wf.stages.forEach(s => stageRepo.addDirect(s));
    const uc = new ReorderStages(wfRepo, stageRepo);
    // Duplicate the first id
    await expect(uc.execute(wf.id, [wf.stages[0].id, wf.stages[0].id])).rejects.toThrow(ReorderSetMismatchError);
  });
});

// ─── MoveTaskToStage ──────────────────────────────────────────────────────────

describe('MoveTaskToStage', () => {
  it('moves task to a new stage', async () => {
    const { taskRepo, stageRepo } = makeRepos();
    const stage = await stageRepo.add('wf-1', { name: 'En progreso', code: 'en_progreso', category: 'enProgreso', order: 0 });
    const uc = new MoveTaskToStage(taskRepo, stageRepo);
    const result = await uc.execute('1', stage.id);
    expect(result.stageId).toBe(stage.id);
  });

  it('throws StageNotFoundError for unknown stage', async () => {
    const { taskRepo, stageRepo } = makeRepos();
    const uc = new MoveTaskToStage(taskRepo, stageRepo);
    await expect(uc.execute('1', 'nonexistent-stage')).rejects.toThrow(StageNotFoundError);
  });

  it('throws TaskNotFoundError for unknown task', async () => {
    const { taskRepo, stageRepo } = makeRepos();
    const stage = await stageRepo.add('wf-1', { name: 'S', code: 's', category: 'nuevo', order: 0 });
    const uc = new MoveTaskToStage(taskRepo, stageRepo);
    await expect(uc.execute('nonexistent-task', stage.id)).rejects.toThrow(TaskNotFoundError);
  });

  it('auto-sets completedAt when moving to hecho stage with completedAt=null', async () => {
    const { taskRepo, stageRepo } = makeRepos();
    const stage = await stageRepo.add('wf-1', { name: 'Hecho', code: 'hecho', category: 'hecho', order: 0 });
    const uc = new MoveTaskToStage(taskRepo, stageRepo);
    // Task 1 has completedAt: null
    const result = await uc.execute('1', stage.id);
    expect(result.completedAt).toBeTruthy();
  });

  it('does not overwrite completedAt when moving to non-hecho stage', async () => {
    const { taskRepo, stageRepo } = makeRepos();
    const hechodStage = await stageRepo.add('wf-1', { name: 'Hecho', code: 'hecho', category: 'hecho', order: 0 });
    const nuevoStage = await stageRepo.add('wf-1', { name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 1 });
    const uc = new MoveTaskToStage(taskRepo, stageRepo);

    // First move to hecho → sets completedAt
    await uc.execute('1', hechodStage.id);
    const afterHecho = await taskRepo.getTask('1');
    const originalCompletedAt = afterHecho!.completedAt;

    // Move back to nuevo → completedAt preserved
    const result = await uc.execute('1', nuevoStage.id);
    expect(result.completedAt).toBe(originalCompletedAt);
  });
});

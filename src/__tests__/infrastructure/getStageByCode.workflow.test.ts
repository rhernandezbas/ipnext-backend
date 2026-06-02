/**
 * TDD — getStageByCode workflow filter (scheduling-stage-code, commit 3)
 * Verifies that getStageByCode(code, workflowId) resolves stages by CODE
 * (rename-safe) and scopes resolution to the given workflow.
 *
 * @deprecated scenarios for getStageByName kept for reference below.
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { Stage } from '../../domain/entities/workflow';

const STAGE_A: Stage = { id: 'stage-a', workflowId: 'wf-1', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'enProgreso', order: 6, color: null };
const STAGE_B: Stage = { id: 'stage-b', workflowId: 'wf-2', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'enProgreso', order: 6, color: null };

function setup() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(STAGE_A);
  stages.addDirect(STAGE_B);
  const repo = new InMemorySchedulingRepository(stages);
  return { repo };
}

describe('getStageByCode — workflow filter (REQ-CODE-4, REQ-CODE-5)', () => {
  it('returns the stage of the requested workflow when codes collide across workflows', async () => {
    const { repo } = setup();
    const a = await repo.getStageByCode('registered_in_iclass', 'wf-1');
    const b = await repo.getStageByCode('registered_in_iclass', 'wf-2');
    expect(a!.id).toBe('stage-a');
    expect(b!.id).toBe('stage-b');
  });

  it('returns null when no stage matches the given code in the given workflow', async () => {
    const { repo } = setup();
    const s = await repo.getStageByCode('registered_in_iclass', 'wf-nope');
    expect(s).toBeNull();
  });

  it('returns null when the code does not exist in any workflow', async () => {
    const { repo } = setup();
    const s = await repo.getStageByCode('nonexistent_code', 'wf-1');
    expect(s).toBeNull();
  });

  it('is rename-safe: resolves the stage even when its name changes', async () => {
    // Operator renames the stage but code is immutable
    const stages = new InMemoryStageRepository();
    stages.addDirect({
      id: 'stage-renamed', workflowId: 'wf-1',
      name: 'En IClass (renombrado)',  // name changed
      code: 'registered_in_iclass',   // code is immutable
      category: 'enProgreso', order: 6, color: null,
    });
    const repo = new InMemorySchedulingRepository(stages);

    const s = await repo.getStageByCode('registered_in_iclass', 'wf-1');
    expect(s!.id).toBe('stage-renamed');
    expect(s!.name).toBe('En IClass (renombrado)');
  });
});

// @deprecated — getStageByName scenarios kept for reference
describe('getStageByName — workflow filter (@deprecated)', () => {
  it('returns the stage of the requested workflow when names collide', async () => {
    const { repo } = setup();
    const a = await repo.getStageByName('Registrado en IClass', 'wf-1');
    const b = await repo.getStageByName('Registrado en IClass', 'wf-2');
    expect(a!.id).toBe('stage-a');
    expect(b!.id).toBe('stage-b');
  });

  it('without workflowId, resolves by name only (backward compatible)', async () => {
    const { repo } = setup();
    const s = await repo.getStageByName('Registrado en IClass');
    expect(s).not.toBeNull();
    expect(s!.name).toBe('Registrado en IClass');
  });

  it('returns null when no stage matches the workflow', async () => {
    const { repo } = setup();
    const s = await repo.getStageByName('Registrado en IClass', 'wf-nope');
    expect(s).toBeNull();
  });
});

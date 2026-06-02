/**
 * TDD — getStageByName workflow filter (task-send-to-iclass, verify WARNING #1)
 * With homonymous stages across workflows, getStageByName(name, workflowId)
 * must resolve the stage belonging to the requested workflow.
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

describe('getStageByName — workflow filter', () => {
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

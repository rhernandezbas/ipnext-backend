/**
 * TDD — MoveTaskToStage hook for "Enviar a IClass" (task-send-to-iclass, Fase 3)
 * Moving to "Enviar a IClass" delegates to SendTaskToIClass; any other stage keeps current behaviour.
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { SendTaskToIClass } from '../../application/use-cases/SendTaskToIClass';
import { StageNotFoundError } from '../../domain/errors/scheduling';
import { Stage } from '../../domain/entities/workflow';

const WF = 'wf-1';
const ENVIAR_STAGE: Stage = { id: 'stage-enviar', workflowId: WF, name: 'Enviar a IClass', code: 'send_to_iclass', category: 'enProgreso', order: 5, color: null };
const REGISTRADO_STAGE: Stage = { id: 'stage-registrado', workflowId: WF, name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'enProgreso', order: 6, color: null };
const OTHER_STAGE: Stage = { id: 'stage-other', workflowId: WF, name: 'En progreso', code: 'en_progreso', category: 'enProgreso', order: 2, color: null };

const DEFAULT_PROJECT = { id: 'proj-1', title: 'Instalaciones FTTH', iclassSoType: { id: 'so-1', code: 'INSTALL', active: true } };

function setup(flagEnabled = true) {
  const stages = new InMemoryStageRepository();
  stages.addDirect(ENVIAR_STAGE);
  stages.addDirect(REGISTRADO_STAGE);
  stages.addDirect(OTHER_STAGE);

  const tasks = new InMemorySchedulingRepository(stages);
  // Seed the project so getTaskProjectMapping resolves for IClass-bound tasks.
  tasks.seedProject(DEFAULT_PROJECT);

  const flags = new InMemoryFeatureFlagRepository();
  flags.seed('iclass-integration', flagEnabled);
  const iclass = new InMemoryIClassClient();
  iclass.nodes = [{ nodeId: 1001, code: 'Rosario', description: 'Rosario' }];

  const sendToIClass = new SendTaskToIClass(tasks, flags, iclass);
  const useCase = new MoveTaskToStage(tasks, stages, sendToIClass);
  return { tasks, stages, iclass, useCase };
}

describe('MoveTaskToStage — IClass hook', () => {
  it('moving to "Enviar a IClass" delegates to SendTaskToIClass (creates OS, advances to Registrado)', async () => {
    const { tasks, iclass, useCase } = setup(true);
    tasks.seedTask({
      id: 't1', stageId: OTHER_STAGE.id, customerId: 'c1', customerCode: 'CLI-1',
      customerName: 'Juan', customerPhone: '341', customerCity: 'Rosario',
      address: 'Calle 1', description: 'desc',
      projectId: DEFAULT_PROJECT.id, // required: project mapping guard
    });

    const result = await useCase.execute('t1', ENVIAR_STAGE.id);

    expect(iclass.createdOrders).toHaveLength(1);
    expect(result.stageId).toBe(REGISTRADO_STAGE.id);
    expect(result.iclassOrderCode).not.toBeNull();
  });

  it('moving to another stage keeps current behaviour (no IClass call)', async () => {
    const { tasks, iclass, useCase } = setup(true);
    tasks.seedTask({ id: 't1', stageId: ENVIAR_STAGE.id });

    const result = await useCase.execute('t1', OTHER_STAGE.id);

    expect(result.stageId).toBe(OTHER_STAGE.id);
    expect(iclass.createdOrders).toHaveLength(0);
  });

  it('throws StageNotFoundError for an unknown target stage', async () => {
    const { tasks, useCase } = setup();
    tasks.seedTask({ id: 't1', stageId: OTHER_STAGE.id });
    await expect(useCase.execute('t1', 'ghost')).rejects.toBeInstanceOf(StageNotFoundError);
  });

  it('works without SendTaskToIClass injected (plain move) for backward compatibility', async () => {
    const stages = new InMemoryStageRepository();
    stages.addDirect(OTHER_STAGE);
    const tasks = new InMemorySchedulingRepository(stages);
    tasks.seedTask({ id: 't1', stageId: ENVIAR_STAGE.id });
    const useCase = new MoveTaskToStage(tasks, stages);

    const result = await useCase.execute('t1', OTHER_STAGE.id);
    expect(result.stageId).toBe(OTHER_STAGE.id);
  });

  it('rename-safe: stage with different name but code "send_to_iclass" MUST trigger IClass (REQ-MOVE-STAGE-1, REQ-LOGIC-1)', async () => {
    // Simulates an operator renaming the stage but code is immutable
    const RENAMED_ENVIAR_STAGE: Stage = {
      id: 'stage-enviar-renamed', workflowId: WF,
      name: 'Despachar a IClass',   // name changed by operator
      code: 'send_to_iclass',       // code is immutable — must still trigger
      category: 'enProgreso', order: 5, color: null,
    };
    const REGISTRADO_STAGE_RENAMED: Stage = {
      id: 'stage-registrado-renamed', workflowId: WF,
      name: 'En IClass',             // name changed too
      code: 'registered_in_iclass',  // code is immutable
      category: 'enProgreso', order: 6, color: null,
    };
    const stages = new InMemoryStageRepository();
    stages.addDirect(RENAMED_ENVIAR_STAGE);
    stages.addDirect(REGISTRADO_STAGE_RENAMED);
    stages.addDirect(OTHER_STAGE);

    const tasks = new InMemorySchedulingRepository(stages);
    tasks.seedProject(DEFAULT_PROJECT);
    const flags = new InMemoryFeatureFlagRepository();
    flags.seed('iclass-integration', true);
    const iclass = new InMemoryIClassClient();
    iclass.nodes = [{ nodeId: 1001, code: 'Rosario', description: 'Rosario' }];
    const sendToIClass = new SendTaskToIClass(tasks, flags, iclass);
    const useCase = new MoveTaskToStage(tasks, stages, sendToIClass);

    tasks.seedTask({
      id: 't1', stageId: OTHER_STAGE.id, customerId: 'c1', customerCode: 'CLI-1',
      customerName: 'Juan', customerPhone: '341', customerCity: 'Rosario',
      address: 'Calle 1', description: 'desc',
      projectId: DEFAULT_PROJECT.id,
    });

    // Moving to the renamed stage (same code) MUST still trigger IClass
    const result = await useCase.execute('t1', RENAMED_ENVIAR_STAGE.id);

    expect(iclass.createdOrders).toHaveLength(1);
    expect(result.stageId).toBe(REGISTRADO_STAGE_RENAMED.id);
  });
});

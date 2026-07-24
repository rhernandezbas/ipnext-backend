import { SetTaskStageTransitionConfig } from '@application/use-cases/SetTaskStageTransitionConfig';
import { GetTaskStageTransitionConfig } from '@application/use-cases/GetTaskStageTransitionConfig';
import { InMemoryTaskStageTransitionConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskStageTransitionConfigRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import type { StageCatalogEntry } from '@infrastructure/adapters/in-memory/InMemoryTaskStageRecipientConfigRepository';
import { ResultingStageNotAllowedError, TaskStageNotFoundError } from '@domain/errors/messaging-task-stage-config';
import type { Stage } from '@domain/entities/workflow';

/**
 * bulk-task-stage-transition (B1.6, TTC-2/TTC-3) — el estado resultante ÚNICO GLOBAL.
 * `SetTaskStageTransitionConfig` valida existencia + prohíbe `send_to_iclass` (decisión 7)
 * ANTES de persistir; `GetTaskStageTransitionConfig` devuelve la vista hidratada.
 */
const catalog: Record<string, StageCatalogEntry> = {
  sB: { name: 'Avisado', code: 'avisado', color: '#0a0', workflowId: 'w1', workflowName: 'Instalaciones' },
  sIclass: { name: 'Enviar a IClass', code: 'send_to_iclass', color: null, workflowId: 'w1', workflowName: 'Instalaciones' },
};

function stageRepoWith(...stages: Stage[]): InMemoryStageRepository {
  const repo = new InMemoryStageRepository();
  stages.forEach((s) => repo.addDirect(s));
  return repo;
}

const stageB: Stage = { id: 'sB', workflowId: 'w1', name: 'Avisado', code: 'avisado', category: 'hecho', order: 3, color: '#0a0' };
const stageIclass: Stage = { id: 'sIclass', workflowId: 'w1', name: 'Enviar a IClass', code: 'send_to_iclass', category: 'enProgreso', order: 2, color: null };

describe('SetTaskStageTransitionConfig', () => {
  it('estado válido → persiste y devuelve la vista hidratada', async () => {
    const config = new InMemoryTaskStageTransitionConfigRepository(catalog);
    const stages = stageRepoWith(stageB);
    const uc = new SetTaskStageTransitionConfig(config, stages);

    const result = await uc.execute({ stageId: 'sB' });

    expect(result.resultingStage?.stageId).toBe('sB');
    expect(await config.getResultingStageId()).toBe('sB');
  });

  it('stageId inexistente → TaskStageNotFoundError, config sin cambios (fail-loud)', async () => {
    const config = new InMemoryTaskStageTransitionConfigRepository(catalog, 'sB');
    const stages = stageRepoWith(stageB);
    const uc = new SetTaskStageTransitionConfig(config, stages);

    await expect(uc.execute({ stageId: 'sGhost' })).rejects.toBeInstanceOf(TaskStageNotFoundError);
    expect(await config.getResultingStageId()).toBe('sB'); // intacto
  });

  it('send_to_iclass → ResultingStageNotAllowedError, config sin cambios (TTC-3, decisión 7)', async () => {
    const config = new InMemoryTaskStageTransitionConfigRepository(catalog, 'sB');
    const stages = stageRepoWith(stageB, stageIclass);
    const uc = new SetTaskStageTransitionConfig(config, stages);

    await expect(uc.execute({ stageId: 'sIclass' })).rejects.toBeInstanceOf(ResultingStageNotAllowedError);
    expect(await config.getResultingStageId()).toBe('sB'); // intacto, nada se aplicó
  });

  it('null → limpia el destino (des-configurar la transición)', async () => {
    const config = new InMemoryTaskStageTransitionConfigRepository(catalog, 'sB');
    const stages = stageRepoWith(stageB);
    const uc = new SetTaskStageTransitionConfig(config, stages);

    const result = await uc.execute({ stageId: null });

    expect(result.resultingStage).toBeNull();
    expect(await config.getResultingStageId()).toBeNull();
  });
});

describe('GetTaskStageTransitionConfig', () => {
  it('devuelve el estado resultante hidratado', async () => {
    const config = new InMemoryTaskStageTransitionConfigRepository(catalog, 'sB');
    const uc = new GetTaskStageTransitionConfig(config);

    expect(await uc.execute()).toEqual({ resultingStage: { stageId: 'sB', stageName: 'Avisado', stageCode: 'avisado', color: '#0a0', workflowId: 'w1', workflowName: 'Instalaciones' } });
  });

  it('sin destino configurado → resultingStage null', async () => {
    const config = new InMemoryTaskStageTransitionConfigRepository(catalog);
    const uc = new GetTaskStageTransitionConfig(config);

    expect(await uc.execute()).toEqual({ resultingStage: null });
  });
});

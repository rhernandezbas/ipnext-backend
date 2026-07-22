/**
 * bulk-task-recipients (B3.1, TSC-3) — `GetTaskStageRecipientConfig`, molde
 * `GetNocBroadcastConfig`: delega en `configRepo.getMappedStages()`, sin
 * transformación propia.
 */
import { GetTaskStageRecipientConfig } from '@application/use-cases/GetTaskStageRecipientConfig';
import { InMemoryTaskStageRecipientConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskStageRecipientConfigRepository';

const catalog = {
  s1: { name: 'Instalación pendiente', code: 'PEND', color: '#fff', workflowId: 'w1', workflowName: 'Instalaciones' },
  s2: { name: 'En proceso', code: 'PROC', color: '#000', workflowId: 'w1', workflowName: 'Instalaciones' },
};

describe('GetTaskStageRecipientConfig', () => {
  it('config vacía (0 stages mapeados) → { stages: [] }', async () => {
    const repo = new InMemoryTaskStageRecipientConfigRepository(catalog, []);
    const useCase = new GetTaskStageRecipientConfig(repo);

    expect(await useCase.execute()).toEqual({ stages: [] });
  });

  it('N stages mapeados → { stages } hidratado tal cual el repo devuelve', async () => {
    const repo = new InMemoryTaskStageRecipientConfigRepository(catalog, ['s1', 's2']);
    const useCase = new GetTaskStageRecipientConfig(repo);

    expect(await useCase.execute()).toEqual({
      stages: [
        { stageId: 's1', stageName: 'Instalación pendiente', stageCode: 'PEND', color: '#fff', workflowId: 'w1', workflowName: 'Instalaciones' },
        { stageId: 's2', stageName: 'En proceso', stageCode: 'PROC', color: '#000', workflowId: 'w1', workflowName: 'Instalaciones' },
      ],
    });
  });
});

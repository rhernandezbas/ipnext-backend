/**
 * bulk-task-recipients (B3.2, TSC-1/TSC-4) — `UpdateTaskStageRecipientConfig`,
 * molde `UpdateNocBroadcastConfig`: dedup ANTES de persistir
 * (`[...new Set(stageIds)]`, TSC-1 "mapear el mismo stage dos veces es
 * imposible" — la constraint `@unique` de la DB es la última línea de
 * defensa, NO la única), delega el replace-set atómico en el repo (D2 — el
 * use case NO hace un pre-chequeo de existencia separado, ver desvío #2 de
 * tasks.md).
 */
import { UpdateTaskStageRecipientConfig } from '@application/use-cases/UpdateTaskStageRecipientConfig';
import { InMemoryTaskStageRecipientConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskStageRecipientConfigRepository';
import { TaskStageNotFoundError } from '@domain/errors/messaging-task-stage-config';

const catalog = {
  s1: { name: 'Instalación pendiente', code: 'PEND', color: '#fff', workflowId: 'w1', workflowName: 'Instalaciones' },
  s2: { name: 'En proceso', code: 'PROC', color: '#000', workflowId: 'w1', workflowName: 'Instalaciones' },
};

describe('UpdateTaskStageRecipientConfig', () => {
  it('replace-set exitoso: execute({stageIds:["s1","s2"]}) sobre ambos existentes → repo queda EXACTAMENTE [s1,s2], retorna {stages} hidratado (TSC-4)', async () => {
    const repo = new InMemoryTaskStageRecipientConfigRepository(catalog, []);
    const useCase = new UpdateTaskStageRecipientConfig(repo);

    const result = await useCase.execute({ stageIds: ['s1', 's2'] });

    expect(await repo.listMappedStageIds()).toEqual(['s1', 's2']);
    expect(result).toEqual({
      stages: [
        { stageId: 's1', stageName: 'Instalación pendiente', stageCode: 'PEND', color: '#fff', workflowId: 'w1', workflowName: 'Instalaciones' },
        { stageId: 's2', stageName: 'En proceso', stageCode: 'PROC', color: '#000', workflowId: 'w1', workflowName: 'Instalaciones' },
      ],
    });
  });

  it('stageId inexistente → el error tipado del repo propaga tal cual, config previa INTACTA (TSC-4 "rechazado, nada se aplica")', async () => {
    const repo = new InMemoryTaskStageRecipientConfigRepository(catalog, ['s1']);
    const useCase = new UpdateTaskStageRecipientConfig(repo);

    await expect(useCase.execute({ stageIds: ['s1', 'stage-inexistente'] })).rejects.toBeInstanceOf(
      TaskStageNotFoundError,
    );
    expect(await repo.listMappedStageIds()).toEqual(['s1']);
  });

  it('execute({stageIds:["s1","s1","s2"]}) → llama a replaceMappedStages(["s1","s2"]) DEDUPLICADO (spy del repo)', async () => {
    const repo = new InMemoryTaskStageRecipientConfigRepository(catalog, []);
    const replaceSpy = jest.spyOn(repo, 'replaceMappedStages');
    const useCase = new UpdateTaskStageRecipientConfig(repo);

    await useCase.execute({ stageIds: ['s1', 's1', 's2'] });

    expect(replaceSpy).toHaveBeenCalledWith(['s1', 's2']);
  });
});

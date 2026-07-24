import { InMemoryTaskStageTransitionConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskStageTransitionConfigRepository';
import type { StageCatalogEntry } from '@infrastructure/adapters/in-memory/InMemoryTaskStageRecipientConfigRepository';

/**
 * bulk-task-stage-transition (B1.4, TTC-1/TTC-2) — in-memory mirror of the singleton
 * transition-config port. A fixture catalog hydrates `getResultingStage`; an internal
 * nullable `resultingStageId` holds the single global destino.
 */
const catalog: Record<string, StageCatalogEntry> = {
  sB: { name: 'Avisado', code: 'avisado', color: '#0a0', workflowId: 'w1', workflowName: 'Instalaciones' },
  sC: { name: 'Notificado', code: 'notificado', color: null, workflowId: 'w1', workflowName: 'Instalaciones' },
};

describe('InMemoryTaskStageTransitionConfigRepository', () => {
  it('sin config → resultingStageId null y resultingStage null (default, TTC-1)', async () => {
    const repo = new InMemoryTaskStageTransitionConfigRepository(catalog);
    expect(await repo.getResultingStageId()).toBeNull();
    expect(await repo.getResultingStage()).toBeNull();
  });

  it('set → get devuelve el id y la vista hidratada (TTC-2)', async () => {
    const repo = new InMemoryTaskStageTransitionConfigRepository(catalog);
    await repo.setResultingStageId('sB');
    expect(await repo.getResultingStageId()).toBe('sB');
    expect(await repo.getResultingStage()).toEqual({
      stageId: 'sB',
      stageName: 'Avisado',
      stageCode: 'avisado',
      color: '#0a0',
      workflowId: 'w1',
      workflowName: 'Instalaciones',
    });
  });

  it('set reemplaza el valor previo (TTC-2)', async () => {
    const repo = new InMemoryTaskStageTransitionConfigRepository(catalog, 'sB');
    await repo.setResultingStageId('sC');
    expect(await repo.getResultingStageId()).toBe('sC');
  });

  it('set con null limpia el destino (TTC-2)', async () => {
    const repo = new InMemoryTaskStageTransitionConfigRepository(catalog, 'sB');
    await repo.setResultingStageId(null);
    expect(await repo.getResultingStageId()).toBeNull();
    expect(await repo.getResultingStage()).toBeNull();
  });

  it('id seteado pero fuera del catálogo → getResultingStage null (defensivo, stage borrado)', async () => {
    const repo = new InMemoryTaskStageTransitionConfigRepository(catalog, 'sGhost');
    expect(await repo.getResultingStageId()).toBe('sGhost');
    expect(await repo.getResultingStage()).toBeNull();
  });
});

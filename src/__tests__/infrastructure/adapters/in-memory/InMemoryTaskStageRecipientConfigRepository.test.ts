/**
 * bulk-task-recipients (B2.3, TSC-2/TSC-4) — InMemoryTaskStageRecipientConfigRepository:
 * mirrors the Prisma adapter's replace-set contract. Constructor receives a fixture
 * catalog `stageId -> {name, code, color, workflowId, workflowName}` (mirrors the
 * `Stage` universe) plus an internal mapped `Set`. `replaceMappedStages` validates
 * against the catalog (mirrors the real FK) — todo-o-nada, never a partial replace.
 */
import { InMemoryTaskStageRecipientConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskStageRecipientConfigRepository';
import { MappedStage } from '@domain/ports/TaskStageRecipientConfigRepository';

const CATALOG = {
  A: { name: 'Nuevo', code: 'nuevo', color: '#111111', workflowId: 'wf-1', workflowName: 'Instalaciones' },
  B: { name: 'En progreso', code: 'en-progreso', color: '#222222', workflowId: 'wf-1', workflowName: 'Instalaciones' },
  C: { name: 'Hecho', code: 'hecho', color: '#333333', workflowId: 'wf-1', workflowName: 'Instalaciones' },
  s1: { name: 'Reclamo abierto', code: 'reclamo-abierto', color: null, workflowId: 'wf-2', workflowName: 'Reclamos' },
};

describe('InMemoryTaskStageRecipientConfigRepository', () => {
  it('replaceMappedStages([B,C]) sobre config [A,B] reemplaza — queda EXACTAMENTE [B,C]', async () => {
    const repo = new InMemoryTaskStageRecipientConfigRepository(CATALOG, ['A', 'B']);

    await repo.replaceMappedStages(['B', 'C']);

    expect((await repo.listMappedStageIds()).sort()).toEqual(['B', 'C']);
  });

  it('replaceMappedStages([]) sobre [A,B,C] limpia toda la config — vacío, sin error', async () => {
    const repo = new InMemoryTaskStageRecipientConfigRepository(CATALOG, ['A', 'B', 'C']);

    await expect(repo.replaceMappedStages([])).resolves.toBeUndefined();

    expect(await repo.listMappedStageIds()).toEqual([]);
  });

  it("replaceMappedStages(['s1','stage-inexistente']) rechaza TODO-O-NADA — la config previa NO cambia", async () => {
    const repo = new InMemoryTaskStageRecipientConfigRepository(CATALOG, ['A']);

    await expect(repo.replaceMappedStages(['s1', 'stage-inexistente'])).rejects.toThrow();

    // config previa intacta — NUNCA se aplicó s1 solo
    expect(await repo.listMappedStageIds()).toEqual(['A']);
  });

  it('getMappedStages() devuelve hidratado (stageId,name,code,color,workflowId,workflowName) para cada id del Set', async () => {
    const repo = new InMemoryTaskStageRecipientConfigRepository(CATALOG, ['A', 's1']);

    const stages = await repo.getMappedStages();

    expect(stages.sort((a: MappedStage, b: MappedStage) => a.stageId.localeCompare(b.stageId))).toEqual([
      {
        stageId: 'A',
        stageName: 'Nuevo',
        stageCode: 'nuevo',
        color: '#111111',
        workflowId: 'wf-1',
        workflowName: 'Instalaciones',
      },
      {
        stageId: 's1',
        stageName: 'Reclamo abierto',
        stageCode: 'reclamo-abierto',
        color: null,
        workflowId: 'wf-2',
        workflowName: 'Reclamos',
      },
    ]);
  });
});

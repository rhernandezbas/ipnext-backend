/**
 * bulk-task-recipients (B4.2, TASK-2, D3) — `assertTaskStagesEligible`, molde
 * `assertHasRecipients.ts:16-24`: guard de elegibilidad del 5to dominio
 * "Tarea" — TODOS los `taskStageIds` pedidos deben estar en el set mapeado
 * ANTES de resolver clientes (autoridad CROSS-dominio, el BE nunca confía en
 * el composer).
 */
import { assertTaskStagesEligible } from '@application/use-cases/messaging/assertTaskStagesEligible';
import { TaskStageNotEligibleError } from '@domain/errors/messaging-bulk';
import type { TaskStageRecipientConfigRepository } from '@domain/ports/TaskStageRecipientConfigRepository';

function makeConfigRepo(mapped: string[]): TaskStageRecipientConfigRepository {
  return {
    listMappedStageIds: jest.fn(async () => mapped),
    getMappedStages: jest.fn(async () => []),
    replaceMappedStages: jest.fn(async () => undefined),
  };
}

describe('assertTaskStagesEligible', () => {
  it('subset inválido: ["stageA"] mapeado, pide ["stageA","stageB"] → TaskStageNotEligibleError con ineligibleStageIds:["stageB"] (TASK-2 scenario 1)', async () => {
    const configRepo = makeConfigRepo(['stageA']);

    await expect(assertTaskStagesEligible(['stageA', 'stageB'], configRepo)).rejects.toMatchObject({
      ineligibleStageIds: ['stageB'],
    });
    await expect(assertTaskStagesEligible(['stageA', 'stageB'], configRepo)).rejects.toBeInstanceOf(
      TaskStageNotEligibleError,
    );
  });

  it('config totalmente vacía + request con taskStageIds → TaskStageNotEligibleError (TASK-2 "config vacía + request → 422")', async () => {
    const configRepo = makeConfigRepo([]);

    await expect(assertTaskStagesEligible(['cualquiera'], configRepo)).rejects.toBeInstanceOf(
      TaskStageNotEligibleError,
    );
  });

  it('taskStageIds vacío → resuelve SIN llamar a configRepo (ni siquiera exige que esté presente)', async () => {
    const configRepo = makeConfigRepo(['stageA']);
    const spy = configRepo.listMappedStageIds as jest.Mock;

    await expect(assertTaskStagesEligible([], configRepo)).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    await expect(assertTaskStagesEligible([])).resolves.toBeUndefined();
  });

  it('taskStageIds NO vacío + configRepo ausente → Error defensivo (nunca ocurre en el wiring real)', async () => {
    await expect(assertTaskStagesEligible(['stageA'])).rejects.toThrow();
  });

  it('subset totalmente elegible → resuelve sin lanzar', async () => {
    const configRepo = makeConfigRepo(['stageA', 'stageB']);

    await expect(assertTaskStagesEligible(['stageA', 'stageB'], configRepo)).resolves.toBeUndefined();
  });
});

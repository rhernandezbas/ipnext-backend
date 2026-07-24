import { TransitionTaskAfterSend } from '@application/use-cases/messaging/TransitionTaskAfterSend';
import { MoveTaskToStage } from '@application/use-cases/MoveTaskToStage';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import type { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import type { ScheduledTask } from '@domain/entities/scheduling';
import type { Stage } from '@domain/entities/workflow';

/**
 * bulk-task-stage-transition (B4.2, TRANS-2/TRANS-3) — el guard still-in-A + el guard
 * anti-send_to_iclass, reusando `MoveTaskToStage`. Fake mínimo de scheduling (getTask +
 * moveTaskToStage son lo único que ejerce este camino sin recorder).
 */
const stageA: Stage = { id: 'sA', workflowId: 'w1', name: 'Pend. aviso', code: 'pend', category: 'nuevo', order: 1, color: null };
const stageB: Stage = { id: 'sB', workflowId: 'w1', name: 'Avisado', code: 'avisado', category: 'hecho', order: 2, color: null };
const stageIclass: Stage = { id: 'sIclass', workflowId: 'w1', name: 'IClass', code: 'send_to_iclass', category: 'enProgreso', order: 3, color: null };

function makeTask(stageId: string): ScheduledTask {
  return { id: 't10', stageId } as ScheduledTask;
}

function makeSchedulingFake(initial: ScheduledTask | null): { repo: SchedulingRepository; current: () => ScheduledTask | null } {
  let task = initial;
  const repo = {
    getTask: async (id: string) => (task && task.id === id ? { ...task } : null),
    moveTaskToStage: async (id: string, stageId: string) => {
      if (!task || task.id !== id) return null;
      task = { ...task, stageId } as ScheduledTask;
      return { ...task };
    },
  } as unknown as SchedulingRepository;
  return { repo, current: () => task };
}

function buildStages(): InMemoryStageRepository {
  const stages = new InMemoryStageRepository();
  [stageA, stageB, stageIclass].forEach((s) => stages.addDirect(s));
  return stages;
}

describe('TransitionTaskAfterSend', () => {
  it('tarea sigue en A → mueve a B (moved)', async () => {
    const { repo, current } = makeSchedulingFake(makeTask('sA'));
    const stages = buildStages();
    const uc = new TransitionTaskAfterSend(repo, stages, new MoveTaskToStage(repo, stages));

    const outcome = await uc.transition({ taskId: 't10', fromStageId: 'sA', toStageId: 'sB' });

    expect(outcome).toBe('moved');
    expect(current()?.stageId).toBe('sB');
  });

  it('TRANS-2: un humano movió la tarea (ya no está en A) → skipped_not_in_origin, no la toca', async () => {
    const { repo, current } = makeSchedulingFake(makeTask('sZ')); // movida a mano fuera de A
    const stages = buildStages();
    const uc = new TransitionTaskAfterSend(repo, stages, new MoveTaskToStage(repo, stages));

    const outcome = await uc.transition({ taskId: 't10', fromStageId: 'sA', toStageId: 'sB' });

    expect(outcome).toBe('skipped_not_in_origin');
    expect(current()?.stageId).toBe('sZ'); // intacta
  });

  it('TRANS-3: destino send_to_iclass → skipped_iclass, NO mueve (no crea OS)', async () => {
    const { repo, current } = makeSchedulingFake(makeTask('sA'));
    const stages = buildStages();
    const uc = new TransitionTaskAfterSend(repo, stages, new MoveTaskToStage(repo, stages));

    const outcome = await uc.transition({ taskId: 't10', fromStageId: 'sA', toStageId: 'sIclass' });

    expect(outcome).toBe('skipped_iclass');
    expect(current()?.stageId).toBe('sA'); // intacta
  });

  it('tarea inexistente → skipped_not_in_origin', async () => {
    const { repo } = makeSchedulingFake(null);
    const stages = buildStages();
    const uc = new TransitionTaskAfterSend(repo, stages, new MoveTaskToStage(repo, stages));

    expect(await uc.transition({ taskId: 't10', fromStageId: 'sA', toStageId: 'sB' })).toBe('skipped_not_in_origin');
  });
});

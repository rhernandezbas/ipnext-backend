import { MoveTaskToStage } from '@application/use-cases/MoveTaskToStage';
import type { SendTaskToIClass } from '@application/use-cases/SendTaskToIClass';
import { BulkMoveTasksToStage } from '@application/use-cases/BulkMoveTasksToStage';
import { SetTaskInventoryReview } from '@application/use-cases/SetTaskInventoryReview';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { FakeTaskActivityRecorder } from '../helpers/FakeTaskActivityRecorder';

const ACTOR = { actorId: 'u1', actorName: 'Alice' };

async function twoStages() {
  const stageRepo = new InMemoryStageRepository();
  const s1 = await stageRepo.add('wf', { name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 0 });
  const s2 = await stageRepo.add('wf', { name: 'En progreso', code: 'ep', category: 'enProgreso', order: 1 });
  return { stageRepo, s1, s2 };
}

describe('MoveTaskToStage activity (D.3)', () => {
  it('emits stage_changed with from/to ids and stage names', async () => {
    const { stageRepo, s1, s2 } = await twoStages();
    const repo = new InMemorySchedulingRepository(stageRepo);
    repo.seedTask({ id: 'task-1', stageId: s1.id });
    const recorder = new FakeTaskActivityRecorder();
    const uc = new MoveTaskToStage(repo, stageRepo, undefined, recorder);

    await uc.execute('task-1', s2.id, ACTOR);

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]).toMatchObject({
      taskId: 'task-1',
      type: 'stage_changed',
      payload: {
        actor: ACTOR,
        fromValue: s1.id,
        toValue: s2.id,
        metadata: { fromStageId: s1.id, toStageId: s2.id, fromStageName: 'Nuevo', toStageName: 'En progreso' },
      },
    });
  });

  it('emits stage_changed even when delegating to IClass, before sent_to_iclass (#2)', async () => {
    const stageRepo = new InMemoryStageRepository();
    const s1 = await stageRepo.add('wf', { name: 'Nuevo', code: 'nuevo', category: 'nuevo', order: 0 });
    const sIclass = await stageRepo.add('wf', { name: 'Enviar a IClass', code: 'send_to_iclass', category: 'enProgreso', order: 5 });
    const repo = new InMemorySchedulingRepository(stageRepo);
    repo.seedTask({ id: 'task-1', stageId: s1.id });
    const recorder = new FakeTaskActivityRecorder();
    // Fake delegate: stands in for SendTaskToIClass (its own sent_to_iclass is tested elsewhere).
    const fakeSend = { execute: async () => repo.getTask('task-1') } as unknown as SendTaskToIClass;
    const uc = new MoveTaskToStage(repo, stageRepo, fakeSend, recorder);

    await uc.execute('task-1', sIclass.id, ACTOR);

    expect(recorder.calls).toContainEqual(
      expect.objectContaining({ taskId: 'task-1', type: 'stage_changed', payload: expect.objectContaining({ toValue: sIclass.id }) }),
    );
  });

  it('does not emit when the task is already in the target stage', async () => {
    const { stageRepo, s1 } = await twoStages();
    const repo = new InMemorySchedulingRepository(stageRepo);
    repo.seedTask({ id: 'task-1', stageId: s1.id });
    const recorder = new FakeTaskActivityRecorder();
    const uc = new MoveTaskToStage(repo, stageRepo, undefined, recorder);

    await uc.execute('task-1', s1.id, ACTOR);

    expect(recorder.calls).toHaveLength(0);
  });
});

describe('BulkMoveTasksToStage activity (D.4)', () => {
  it('threads the actor so each moved task emits stage_changed', async () => {
    const { stageRepo, s1, s2 } = await twoStages();
    const repo = new InMemorySchedulingRepository(stageRepo);
    repo.seedTask({ id: 't1', stageId: s1.id });
    repo.seedTask({ id: 't2', stageId: s1.id });
    const recorder = new FakeTaskActivityRecorder();
    const move = new MoveTaskToStage(repo, stageRepo, undefined, recorder);
    const bulk = new BulkMoveTasksToStage(move);

    await bulk.execute(['t1', 't2'], s2.id, ACTOR);

    expect(recorder.calls.filter(c => c.type === 'stage_changed')).toHaveLength(2);
  });
});

describe('SetTaskInventoryReview activity (D.7)', () => {
  it('emits inventory_review_changed with the new value', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTask({ id: 'task-1' });
    const recorder = new FakeTaskActivityRecorder();
    const uc = new SetTaskInventoryReview(repo, recorder);

    await uc.execute('task-1', true, 'u1', ACTOR);

    expect(recorder.calls).toContainEqual(
      expect.objectContaining({
        type: 'inventory_review_changed',
        payload: expect.objectContaining({ actor: ACTOR, toValue: true }),
      }),
    );
  });
});

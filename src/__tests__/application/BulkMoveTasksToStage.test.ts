/**
 * TDD — BulkMoveTasksToStage (task-bulk-send-to-iclass, AD-1/3/5)
 * Orchestrates MoveTaskToStage per id with bounded concurrency, capturing per-task
 * results. Never throws on a per-task failure; always returns { summary, results }.
 */
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { SendTaskToIClass } from '../../application/use-cases/SendTaskToIClass';
import { BulkMoveTasksToStage } from '../../application/use-cases/BulkMoveTasksToStage';
import {
  MissingRequiredFieldsError,
  TaskNotFoundError,
  StageNotFoundError,
} from '../../domain/errors/scheduling';
import {
  IClassNodeNotFoundError,
  IClassRejectedError,
  IClassUnavailableError,
} from '../../domain/errors/iclass';
import { Stage } from '../../domain/entities/workflow';

const WF = 'wf-1';
const OTHER_STAGE: Stage = { id: 'stage-other', workflowId: WF, name: 'En progreso', category: 'enProgreso', order: 2, color: null };

function setupReal() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(OTHER_STAGE);
  const tasks = new InMemorySchedulingRepository(stages);
  const flags = new InMemoryFeatureFlagRepository();
  flags.seed('iclass-integration', true);
  const iclass = new InMemoryIClassClient();
  const sendToIClass = new SendTaskToIClass(tasks, flags, iclass);
  const move = new MoveTaskToStage(tasks, stages, sendToIClass);
  return { tasks, stages, iclass, move };
}

describe('BulkMoveTasksToStage', () => {
  it('all OK -> every result ok:true, summary {total, ok, failed}', async () => {
    const { tasks, move } = setupReal();
    tasks.seedTask({ id: 'ok1', stageId: 'seed' });
    tasks.seedTask({ id: 'ok2', stageId: 'seed' });
    const bulk = new BulkMoveTasksToStage(move);

    const out = await bulk.execute(['ok1', 'ok2'], OTHER_STAGE.id);

    expect(out.summary).toEqual({ total: 2, ok: 2, failed: 0 });
    expect(out.results).toEqual([
      { taskId: 'ok1', ok: true },
      { taskId: 'ok2', ok: true },
    ]);
  });

  it('partial failure (ok1/bad/ok2) does NOT throw; ok ones move, bad reported', async () => {
    const { tasks, move } = setupReal();
    tasks.seedTask({ id: 'ok1', stageId: 'seed' });
    tasks.seedTask({ id: 'ok2', stageId: 'seed' });
    // 'bad' is not seeded -> TaskNotFoundError
    const bulk = new BulkMoveTasksToStage(move);

    const out = await bulk.execute(['ok1', 'bad', 'ok2'], OTHER_STAGE.id);

    expect(out.summary).toEqual({ total: 3, ok: 2, failed: 1 });
    expect(out.results[0]).toEqual({ taskId: 'ok1', ok: true });
    expect(out.results[1]).toEqual({ taskId: 'bad', ok: false, errorCode: 'TASK_NOT_FOUND' });
    expect(out.results[2]).toEqual({ taskId: 'ok2', ok: true });
  });

  it('stage that is not IClass -> all ok, no IClass calls', async () => {
    const { tasks, iclass, move } = setupReal();
    tasks.seedTask({ id: 'a', stageId: 'seed' });
    tasks.seedTask({ id: 'b', stageId: 'seed' });
    const bulk = new BulkMoveTasksToStage(move);

    const out = await bulk.execute(['a', 'b'], OTHER_STAGE.id);

    expect(out.summary.ok).toBe(2);
    expect(iclass.createdOrders).toHaveLength(0);
  });

  it('12 ids -> 12 results, order preserved', async () => {
    const { tasks, move } = setupReal();
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    ids.forEach((id) => tasks.seedTask({ id, stageId: 'seed' }));
    const bulk = new BulkMoveTasksToStage(move);

    const out = await bulk.execute(ids, OTHER_STAGE.id);

    expect(out.results).toHaveLength(12);
    expect(out.results.map((r) => r.taskId)).toEqual(ids);
    expect(out.summary).toEqual({ total: 12, ok: 12, failed: 0 });
  });

  describe('domain error mapping per task', () => {
    // A MoveTaskToStage double that throws a configured error per id.
    function makeBulkWith(errorByid: Record<string, Error>) {
      const move = {
        execute: async (taskId: string) => {
          const e = errorByid[taskId];
          if (e) throw e;
          return {} as never;
        },
      } as unknown as MoveTaskToStage;
      return new BulkMoveTasksToStage(move);
    }

    it('MissingRequiredFieldsError -> MISSING_REQUIRED_FIELDS + missingFields', async () => {
      const bulk = makeBulkWith({ x: new MissingRequiredFieldsError(['phone']) });
      const out = await bulk.execute(['x'], 's');
      expect(out.results[0]).toEqual({
        taskId: 'x', ok: false, errorCode: 'MISSING_REQUIRED_FIELDS', missingFields: ['phone'],
      });
    });

    it('IClassNodeNotFoundError -> ICLASS_NODE_NOT_FOUND', async () => {
      const bulk = makeBulkWith({ x: new IClassNodeNotFoundError('Rosario') });
      const out = await bulk.execute(['x'], 's');
      expect(out.results[0]).toEqual({ taskId: 'x', ok: false, errorCode: 'ICLASS_NODE_NOT_FOUND' });
    });

    it('IClassRejectedError -> ICLASS_REJECTED + reason', async () => {
      const bulk = makeBulkWith({ x: new IClassRejectedError('ICLERR_0045: too long') });
      const out = await bulk.execute(['x'], 's');
      expect(out.results[0]).toEqual({
        taskId: 'x', ok: false, errorCode: 'ICLASS_REJECTED', reason: 'ICLERR_0045: too long',
      });
    });

    it('IClassUnavailableError -> ICLASS_UNAVAILABLE', async () => {
      const bulk = makeBulkWith({ x: new IClassUnavailableError() });
      const out = await bulk.execute(['x'], 's');
      expect(out.results[0]).toEqual({ taskId: 'x', ok: false, errorCode: 'ICLASS_UNAVAILABLE' });
    });

    it('StageNotFoundError -> STAGE_NOT_FOUND', async () => {
      const bulk = makeBulkWith({ x: new StageNotFoundError('s') });
      const out = await bulk.execute(['x'], 's');
      expect(out.results[0]).toEqual({ taskId: 'x', ok: false, errorCode: 'STAGE_NOT_FOUND' });
    });

    it('unknown (non-domain) error -> UNKNOWN', async () => {
      const bulk = makeBulkWith({ x: new Error('boom') });
      const out = await bulk.execute(['x'], 's');
      expect(out.results[0]).toEqual({ taskId: 'x', ok: false, errorCode: 'UNKNOWN' });
    });
  });
});

/**
 * Test suite for CloseIClassServiceOrder use case.
 * Covers scenarios C1-C11 from the design matrix.
 * STRICT TDD — tests written before implementation.
 */
import { CloseIClassServiceOrder } from '@application/use-cases/CloseIClassServiceOrder';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import {
  IClassActionDisabledError,
  IClassTaskNotOpenError,
  IClassAlreadyClosedError,
  IClassNoServiceOrderError,
  IClassUnavailableError,
  IClassRejectedError,
  IClassResultCodeNotFoundError,
} from '@domain/errors/iclass';
import { TaskNotFoundError } from '@domain/errors/scheduling';

const TASK_ID = 'task-1';
const ORDER_CODE = 'OS-100';
const RESULT_CODE = 'RESOLVIDO';
const ACTOR = { actorId: 'user-1', actorName: 'Operator' };

async function makeRepos() {
  const stageRepo = new InMemoryStageRepository();
  const schedulingRepo = new InMemorySchedulingRepository(stageRepo);
  const iclass = new InMemoryIClassClient();
  const resultCodeRepo = new InMemoryIClassResultCodeRepository();
  const flagRepo = new InMemoryFeatureFlagRepository();

  // Seed a valid result code
  await resultCodeRepo.upsert({ code: RESULT_CODE, type: 'Sucesso', soTypeId: null });

  // Seed flag as ON by default (individual tests can turn it OFF)
  flagRepo.seed('iclass-close-action', true);

  // Seed a task with an iclassOrderCode (open by default)
  schedulingRepo.seedTask({
    id: TASK_ID,
    iclassOrderCode: ORDER_CODE,
    generalStatus: 'open',
    title: 'Task with OS',
  });

  // Seed a snapshot in iclass so getServiceOrder returns non-terminal
  iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-id-1', iclassCodigo: ORDER_CODE, statusCode: '1', statusDescription: 'Aberta' });

  return { schedulingRepo, iclass, resultCodeRepo, flagRepo };
}

describe('CloseIClassServiceOrder', () => {
  // C1: flag OFF → IClassActionDisabledError, IClass NOT called
  it('C1: flag OFF → throws IClassActionDisabledError without calling IClass', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    flagRepo.seed('iclass-close-action', false);
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'cierre', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassActionDisabledError);
    expect(iclass.getCloseCalls()).toHaveLength(0);
    expect(iclass.getGetServiceOrderCalls()).toHaveLength(0);
  });

  // C2: task not found → TaskNotFoundError
  it('C2: task not found → TaskNotFoundError', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: 'nonexistent', resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(TaskNotFoundError);
  });

  // C3: task without iclassOrderCode → IClassNoServiceOrderError (422)
  it('C3: task without iclassOrderCode → IClassNoServiceOrderError', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    schedulingRepo.seedTask({ id: 'task-no-os', iclassOrderCode: null, generalStatus: 'open', title: 'No OS' });
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: 'task-no-os', resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassNoServiceOrderError);
    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  // C4: task generalStatus !== 'open' → IClassTaskNotOpenError (409)
  it('C4: task not open → IClassTaskNotOpenError', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    schedulingRepo.seedTask({ id: 'task-closed', iclassOrderCode: ORDER_CODE, generalStatus: 'closed', title: 'Closed task' });
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: 'task-closed', resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassTaskNotOpenError);
    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  // C5: resultCode not in catalog → IClassResultCodeNotFoundError (404)
  it('C5: resultCode not in catalog → IClassResultCodeNotFoundError', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: TASK_ID, resultCode: 'NONEXISTENT', commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassResultCodeNotFoundError);
    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  // C6: pre-check returns statusCode '7' → IClassAlreadyClosedError (409), close NOT called
  it('C6: OS already terminal in IClass → IClassAlreadyClosedError, close NOT called', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-id-1', iclassCodigo: ORDER_CODE, statusCode: '7', statusDescription: 'Fechada' });
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassAlreadyClosedError);
    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  // C7: getServiceOrder returns null → IClassNoServiceOrderError (422)
  it('C7: getServiceOrder null → IClassNoServiceOrderError', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    iclass.setServiceOrderSnapshot(ORDER_CODE, null);
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassNoServiceOrderError);
    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  // C8: happy path → close called with correct payload, generalStatus='closed', activity recorded
  it('C8: happy path — close called with payload, task closed, activity recorded', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    const activityLog: { type: string; toValue: unknown }[] = [];
    const recorder = {
      record: async (_taskId: string, type: string, payload: { actor: unknown; fromValue?: unknown; toValue?: unknown }) => {
        activityLog.push({ type, toValue: payload.toValue });
      },
      recordMany: async () => {},
    };

    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo, recorder);
    const result = await uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'OS cerrada por operador', actorId: 'u1' });

    // Close was called
    const closeCalls = iclass.getCloseCalls();
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]!.serviceOrderCode).toBe(ORDER_CODE);
    expect(closeCalls[0]!.resultCode).toBe(RESULT_CODE);
    expect(closeCalls[0]!.commentary).toBe('OS cerrada por operador');

    // Task was updated to closed
    const task = await schedulingRepo.getTask(TASK_ID);
    expect(task!.generalStatus).toBe('closed');

    // Activity was recorded
    expect(activityLog).toHaveLength(1);
    expect(activityLog[0]!.type).toBe('status_changed');
    expect(activityLog[0]!.toValue).toBe('closed');

    // Result is the updated task DTO
    expect(result.generalStatus).toBe('closed');
  });

  // C9: IClass rejects → IClassRejectedError, task NOT closed locally
  it('C9: IClass rejects → propagates IClassRejectedError, task NOT closed', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    iclass.setCloseMode('rejected');
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassRejectedError);

    const task = await schedulingRepo.getTask(TASK_ID);
    expect(task!.generalStatus).toBe('open');
  });

  // C10: IClass unavailable → IClassUnavailableError, task NOT closed
  it('C10: IClass unavailable → propagates IClassUnavailableError, task NOT closed', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    iclass.setCloseMode('unavailable');
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassUnavailableError);

    const task = await schedulingRepo.getTask(TASK_ID);
    expect(task!.generalStatus).toBe('open');
  });

  // C11: task already closed — guard prevents re-close (idempotent)
  it('C11: task already closed — guard returns task without re-calling IClass', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    // Pre-close the task
    schedulingRepo.seedTask({ id: 'task-already-closed', iclassOrderCode: ORDER_CODE, generalStatus: 'closed', title: 'Already closed' });
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    // Should throw IClassTaskNotOpenError because the task is already closed (check step 4)
    await expect(uc.execute({ taskId: 'task-already-closed', resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassTaskNotOpenError);
    expect(iclass.getCloseCalls()).toHaveLength(0);
  });

  // wave-1a (cierre atómico) — closure routed through the atomic guard (origin=staff).
  it('wave-1a: happy path sets closureOrigin=staff on the closed task', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    const result = await uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' });

    expect(result.closureOrigin).toBe('staff');
  });

  // wave-1a — closes the gap between step 4's `generalStatus === 'open'` check (line ~70)
  // and the local write (line ~101): a concurrent closer (e.g. the ingest cron) can win
  // the race in that window. This call already pushed the close to IClass (best-effort,
  // external system of record); losing the LOCAL race must not throw — it returns
  // whatever the atomic guard decided, same as every other writer in this wave.
  it('wave-1a: loses the local race to a concurrent iclass close AFTER already pushing to IClass — returns the winner, no throw', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    schedulingRepo.setBeforeCloseWriteHook(async () => {
      schedulingRepo.setBeforeCloseWriteHook(undefined);
      await schedulingRepo.closeTaskIfOpen(TASK_ID, { origin: 'iclass', resultCode: 'REAGENDADO' });
    });

    const result = await uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' });

    // The push to IClass still happened — it is a separate, external concern.
    expect(iclass.getCloseCalls()).toHaveLength(1);
    // But the LOCAL state reflects whoever actually won the atomic race.
    expect(result.generalStatus).toBe('closed');
    expect(result.closureOrigin).toBe('iclass');
  });
});

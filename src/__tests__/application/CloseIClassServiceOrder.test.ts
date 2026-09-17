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
import { ICLASS_COMPLETED_IN_PROMINENSE, ICLASS_CANCELLED_IN_PROMINENSE } from '@application/use-cases/iclassProminenseResultCodes';
import { Stage } from '@domain/entities/workflow';

const TASK_ID = 'task-1';
const ORDER_CODE = 'OS-100';
const RESULT_CODE = 'RESOLVIDO';
const ACTOR = { actorId: 'user-1', actorName: 'Operator' };

const IN_FLIGHT_STAGE: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'enProgreso', order: 5, color: null };

async function makeRepos() {
  const stageRepo = new InMemoryStageRepository();
  stageRepo.addDirect(IN_FLIGHT_STAGE);
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
    stageId: IN_FLIGHT_STAGE.id,
  });

  // Seed a snapshot in iclass so getServiceOrder returns non-terminal
  iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-id-1', iclassCodigo: ORDER_CODE, statusCode: '1', statusDescription: 'Aberta' });

  return { schedulingRepo, iclass, resultCodeRepo, flagRepo, stageRepo };
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

  // ── Prominense-close retry: operational result codes always reject in IClass ──
  // ICLERR_0216 (result code not associated to the SO type) and ICLERR_0217 (the
  // result code's survey has mandatory questions) are hit by EVERY operational code,
  // because those two codes were created in IClass with no survey and associated to
  // every SO type specifically to absorb this.

  it('C12: IClass rejects with ICLERR_0216 → retries once with COMPLETADA EN PROMINENSE, closes locally with the OPERATOR resultCode', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    iclass.queueCloseRejection('ICLERR_0216: result code not associated to the SO type');
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    const result = await uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'Cliente ausente', actorId: 'u1' });

    const closeCalls = iclass.getCloseCalls();
    expect(closeCalls).toHaveLength(2); // both attempts recorded, in order
    expect(closeCalls[0]!.resultCode).toBe(RESULT_CODE); // the FIRST attempt carried the operator's own code
    expect(closeCalls[0]!.commentary).toBe('Cliente ausente');
    expect(closeCalls[1]!.resultCode).toBe(ICLASS_COMPLETED_IN_PROMINENSE);
    expect(closeCalls[1]!.commentary).toBe('Cliente ausente (motivo elegido en Prominense: RESOLVIDO)');

    // LOCAL closure keeps the OPERATOR's resultCode, unchanged behaviour.
    expect(result.generalStatus).toBe('closed');
    const details = schedulingRepo.getClosureDetails(TASK_ID);
    expect(details?.resultCode).toBe(RESULT_CODE);
  });

  it('C13: IClass rejects with ICLERR_0217 → retries once with COMPLETADA EN PROMINENSE', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    iclass.queueCloseRejection('ICLERR_0217: a survey with mandatory questions is associated to this result code');
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    const result = await uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: '', actorId: 'u1' });

    const closeCalls = iclass.getCloseCalls();
    expect(closeCalls).toHaveLength(2);
    expect(closeCalls[0]!.resultCode).toBe(RESULT_CODE);
    expect(closeCalls[1]!.resultCode).toBe(ICLASS_COMPLETED_IN_PROMINENSE);
    // Empty commentary is trimmed sensibly — no leading space before the parenthesis.
    expect(closeCalls[1]!.commentary).toBe('(motivo elegido en Prominense: RESOLVIDO)');
    expect(result.generalStatus).toBe('closed');
  });

  it('C14: retry ALSO rejected → the retry rejection propagates (no infinite loop, no local close)', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    iclass.queueCloseRejection('ICLERR_0216: result code not associated to the SO type');
    iclass.queueCloseRejection('ICLERR_0212: SO status does not allow the action');
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassRejectedError);

    expect(iclass.getCloseCalls()).toHaveLength(2); // both rejected attempts recorded, neither succeeded
    const task = await schedulingRepo.getTask(TASK_ID);
    expect(task!.generalStatus).toBe('open');
  });

  it('C17: catalog resultCode type "Falha" → retry falls back to CANCELADA EN PROMINENSE', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    await resultCodeRepo.upsert({ code: 'CLIENTE_AUSENTE', type: 'Falha', soTypeId: null });
    iclass.queueCloseRejection('ICLERR_0217: a survey with mandatory questions is associated to this result code');
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    const result = await uc.execute({ taskId: TASK_ID, resultCode: 'CLIENTE_AUSENTE', commentary: 'no atendió', actorId: 'u1' });

    const closeCalls = iclass.getCloseCalls();
    expect(closeCalls).toHaveLength(2);
    expect(closeCalls[0]!.resultCode).toBe('CLIENTE_AUSENTE');
    expect(closeCalls[1]!.resultCode).toBe(ICLASS_CANCELLED_IN_PROMINENSE);
    expect(result.generalStatus).toBe('closed');
    const details = schedulingRepo.getClosureDetails(TASK_ID);
    expect(details?.resultCode).toBe('CLIENTE_AUSENTE');
  });

  it('C19: a first-attempt rejection that is NOT 0216/0217 propagates WITHOUT retrying', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    iclass.queueCloseRejection('ICLERR_0212: SO status does not allow the action');
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassRejectedError);

    expect(iclass.getCloseCalls()).toHaveLength(1); // the single rejected attempt is recorded, no retry
    const task = await schedulingRepo.getTask(TASK_ID);
    expect(task!.generalStatus).toBe('open');
  });

  it('C20: IClassUnavailableError is not retried and propagates', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    iclass.setCloseMode('unavailable');
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await expect(uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' }))
      .rejects.toBeInstanceOf(IClassUnavailableError);

    expect(iclass.getCloseCalls()).toHaveLength(0);
    const task = await schedulingRepo.getTask(TASK_ID);
    expect(task!.generalStatus).toBe('open');
  });

  // statusCode '50' = Aprovação: the technician already closed the OS from the field
  // app and it is awaiting office approval — pushing a close would be rejected by
  // IClass (ICLERR_0212, status does not allow the action). Skip the push, close LOCAL only.
  it("C16: snapshot statusCode '50' (Aprovação) → closes locally WITHOUT pushing to IClass", async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-id-1', iclassCodigo: ORDER_CODE, statusCode: '50', statusDescription: 'Aprovação' });
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    const result = await uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' });

    expect(iclass.getCloseCalls()).toHaveLength(0);
    expect(result.generalStatus).toBe('closed');
    expect(result.closureOrigin).toBe('staff');
    const details = schedulingRepo.getClosureDetails(TASK_ID);
    expect(details?.resultCode).toBe(RESULT_CODE);
  });

  it("C18: catalog resultCode type 'Pendente' (reagendado) → retry falls back to CANCELADA EN PROMINENSE", async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    await resultCodeRepo.upsert({ code: 'Cliente Ausente', type: 'Pendente', soTypeId: null });
    iclass.queueCloseRejection('ICLERR_0217: a survey with mandatory questions is associated to this result code');
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await uc.execute({ taskId: TASK_ID, resultCode: 'Cliente Ausente', commentary: 'x', actorId: 'u1' });

    const calls = iclass.getCloseCalls();
    expect(calls.map(c => c.resultCode)).toEqual(['Cliente Ausente', 'CANCELADA EN PROMINENSE']);
  });

  // The catalog holds one row per (soTypeId, code) and findByCode returns an arbitrary one,
  // so both decisions derived from the code must read every row of it.
  it('C26: the same code with a non-Sucesso row in ANOTHER soType falls back to CANCELADA', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    await resultCodeRepo.upsert({ code: 'Relevamiento', type: 'Sucesso', soTypeId: 'A' });
    await resultCodeRepo.upsert({ code: 'Relevamiento', type: 'Falha', soTypeId: 'B' });
    iclass.queueCloseRejection('ICLERR_0217: a survey with mandatory questions is associated to this result code');
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    await uc.execute({ taskId: TASK_ID, resultCode: 'Relevamiento', commentary: 'x', actorId: 'u1' });

    expect(iclass.getCloseCalls().map(c => c.resultCode)).toEqual(['Relevamiento', 'CANCELADA EN PROMINENSE']);
  });

  it('C27: the same code mapped to DIFFERENT stages per soType does not move the task', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo, stageRepo } = await makeRepos();
    const stageA: Stage = { id: 'st-a', workflowId: 'wf', name: 'Hecho', code: 'hecho', category: 'hecho', order: 9, color: null };
    const stageB: Stage = { id: 'st-b', workflowId: 'wf', name: 'Ausente', code: 'ausente', category: 'hecho', order: 11, color: null };
    stageRepo.addDirect(stageA);
    stageRepo.addDirect(stageB);
    await resultCodeRepo.upsert({ code: 'Relevamiento', type: 'Sucesso', soTypeId: 'A' });
    await resultCodeRepo.upsert({ code: 'Relevamiento', type: 'Sucesso', soTypeId: 'B' });
    const rows = (await resultCodeRepo.list()).filter(r => r.code === 'Relevamiento');
    await resultCodeRepo.assignStage(rows[0]!.id, stageA.id);
    await resultCodeRepo.assignStage(rows[1]!.id, stageB.id);
    const before = await schedulingRepo.getTask(TASK_ID);
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    const result = await uc.execute({ taskId: TASK_ID, resultCode: 'Relevamiento', commentary: 'x', actorId: 'u1' });

    expect(result.generalStatus).toBe('closed');
    expect(result.stageId).toBe(before!.stageId);
  });

  // ── Stage move on close (same door the cron uses: SchedulingRepository.moveTaskToStage) ──

  it("C21: local close WON + rcEntry.mappedStageId set → moves the task to the operator's own mapped stage", async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo, stageRepo } = await makeRepos();
    const ausenteStage: Stage = { id: 'st-ausente', workflowId: 'wf', name: 'Ausente', code: 'ausente', category: 'hecho', order: 10, color: null };
    stageRepo.addDirect(ausenteStage);
    const rc = await resultCodeRepo.findByCode(RESULT_CODE);
    await resultCodeRepo.assignStage(rc!.id, ausenteStage.id);
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    const result = await uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' });

    expect(result.stageId).toBe(ausenteStage.id);
    const task = await schedulingRepo.getTask(TASK_ID);
    expect(task!.stageId).toBe(ausenteStage.id);
  });

  it('C22: rcEntry has no mappedStageId → the task stage is left untouched', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo } = await makeRepos();
    const before = await schedulingRepo.getTask(TASK_ID);
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    const result = await uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' });

    expect(result.stageId).toBe(before!.stageId);
  });

  it('C23: the local close LOSES the race → does NOT move the stage (the winner is responsible)', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo, stageRepo } = await makeRepos();
    const ausenteStage: Stage = { id: 'st-ausente', workflowId: 'wf', name: 'Ausente', code: 'ausente', category: 'hecho', order: 10, color: null };
    stageRepo.addDirect(ausenteStage);
    const rc = await resultCodeRepo.findByCode(RESULT_CODE);
    await resultCodeRepo.assignStage(rc!.id, ausenteStage.id);
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);
    const before = await schedulingRepo.getTask(TASK_ID);

    schedulingRepo.setBeforeCloseWriteHook(async () => {
      schedulingRepo.setBeforeCloseWriteHook(undefined);
      await schedulingRepo.closeTaskIfOpen(TASK_ID, { origin: 'iclass', resultCode: 'REAGENDADO' });
    });

    const result = await uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' });

    expect(result.closureOrigin).toBe('iclass');
    expect(result.stageId).toBe(before!.stageId); // NOT moved to the loser's mapped stage
  });

  // The close is already committed in IClass and locally by the time the stage moves:
  // a failure there must not turn a successful close into an error for the operator.
  it('C24: the stage move failing does NOT fail the close', async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo, stageRepo } = await makeRepos();
    const ausenteStage: Stage = { id: 'st-ausente', workflowId: 'wf', name: 'Ausente', code: 'ausente', category: 'hecho', order: 10, color: null };
    stageRepo.addDirect(ausenteStage);
    const rc = await resultCodeRepo.findByCode(RESULT_CODE);
    await resultCodeRepo.assignStage(rc!.id, ausenteStage.id);
    schedulingRepo.moveTaskToStageIfForward = async () => {
      throw new Error('stage vanished');
    };
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    const result = await uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' });

    expect(result.generalStatus).toBe('closed');
    expect(iclass.getCloseCalls()).toHaveLength(1);
  });

  it("C25: a mapped stage from ANOTHER workflow does not drag the task to a foreign board", async () => {
    const { schedulingRepo, iclass, resultCodeRepo, flagRepo, stageRepo } = await makeRepos();
    const foreignStage: Stage = { id: 'st-foreign', workflowId: 'other-wf', name: 'Hecho', code: 'hecho', category: 'hecho', order: 10, color: null };
    stageRepo.addDirect(foreignStage);
    const rc = await resultCodeRepo.findByCode(RESULT_CODE);
    await resultCodeRepo.assignStage(rc!.id, foreignStage.id);
    const before = await schedulingRepo.getTask(TASK_ID);
    const uc = new CloseIClassServiceOrder(schedulingRepo, iclass, resultCodeRepo, flagRepo);

    const result = await uc.execute({ taskId: TASK_ID, resultCode: RESULT_CODE, commentary: 'x', actorId: 'u1' });

    expect(result.generalStatus).toBe('closed');
    expect(result.stageId).toBe(before!.stageId);
  });
});

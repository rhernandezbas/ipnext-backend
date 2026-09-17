import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { IClassPort, CloseServiceOrderInput } from '@domain/ports/IClassPort';
import { IClassResultCodeRepository } from '@domain/ports/IClassResultCodeRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { ScheduledTask } from '@domain/entities/scheduling';
import { TaskNotFoundError } from '@domain/errors/scheduling';
import { applyTaskClosure } from './applyTaskClosure';
import { ICLASS_COMPLETED_IN_PROMINENSE, ICLASS_CANCELLED_IN_PROMINENSE } from './iclassProminenseResultCodes';
import { normalizeResultCode } from './normalizeResultCode';
import {
  IClassActionDisabledError,
  IClassTaskNotOpenError,
  IClassAlreadyClosedError,
  IClassNoServiceOrderError,
  IClassResultCodeNotFoundError,
  IClassRejectedError,
} from '@domain/errors/iclass';

/**
 * IClass statusCode meaning "the technician already closed the OS from the field
 * app and it's awaiting office approval". Pushing a close here would be rejected
 * (ICLERR_0212, status does not allow the action) — close LOCAL only, no push.
 */
const ICLASS_STATUS_PENDING_APPROVAL = '50';

/** Every operational result code hits one of these on IClass — no survey-free path exists. */
function isResultCodeRejection(error: unknown): error is IClassRejectedError {
  return (
    error instanceof IClassRejectedError &&
    (error.message.includes('ICLERR_0216') || error.message.includes('ICLERR_0217'))
  );
}

export interface CloseIClassServiceOrderInput {
  taskId: string;
  resultCode: string;
  commentary: string;
  closeDate?: Date;
  actorId: string | null;
}

/**
 * Closes an IClass Service Order from Prominense.
 *
 * Flow (per design AD-1, AD-2, AD-3, AD-6):
 * 1. Check feature flag `iclass-close-action` — OFF → IClassActionDisabledError (409)
 * 2. Resolve task — not found → TaskNotFoundError (404)
 * 3. Check task.iclassOrderCode — null → IClassNoServiceOrderError (422)
 * 4. Check task.generalStatus === 'open' — no → IClassTaskNotOpenError (409)
 * 5. Resolve resultCode from catalog — not found → IClassResultCodeNotFoundError (404)
 * 6. Live pre-check: getServiceOrder
 *    - null → IClassNoServiceOrderError (422)
 *    - statusCode === '7' → IClassAlreadyClosedError (409)
 * 7. closeServiceOrder — IClassRejectedError (422) | IClassUnavailableError (502) propagate
 * 8. Close locally via applyTaskClosure(origin='staff') + record 'status_changed' on a WIN.
 *    wave-1a (cierre atómico): step 4's `generalStatus === 'open'` check is NOT the
 *    idempotency fence anymore — a concurrent closer (e.g. the ingest cron) can still
 *    win between step 4 and here.
 *
 *    FIX-9(b) — SCOPE, honestly: the atomic guard closes the LOCAL window only. It
 *    guarantees that our `generalStatus`/`closureOrigin` write cannot clobber a
 *    concurrent closer's, nothing more. The PUSH to IClass in step 7 has NO fence: it
 *    already happened by the time we get here, and two operators racing this endpoint
 *    can both push a close to IClass with different result codes. That is accepted by
 *    AD-2 (the port is a dumb transport; IClass is the system of record for its own SO
 *    and answers 409/rejection on its side). Losing the LOCAL race after having pushed
 *    does NOT throw — the discrepancy is recorded as a `closure_conflict` activity by
 *    applyTaskClosure and reconciled by the operator, not by this use case.
 * 9. Return updated task DTO
 */
export class CloseIClassServiceOrder {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly iclass: IClassPort,
    private readonly resultCodeRepo: IClassResultCodeRepository,
    private readonly flagRepo: FeatureFlagRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(input: CloseIClassServiceOrderInput): Promise<ScheduledTask> {
    const { taskId, resultCode, commentary, closeDate, actorId } = input;

    // Step 1: Feature flag gate
    const flag = await this.flagRepo.get('iclass-close-action');
    if (!flag?.enabled) {
      throw new IClassActionDisabledError('iclass-close-action');
    }

    // Step 2: Resolve task
    const task = await this.schedulingRepo.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // Step 3: Task must have an iclassOrderCode
    if (!task.iclassOrderCode) {
      throw new IClassNoServiceOrderError('task has no iclassOrderCode');
    }

    // Step 4: Task must be open
    if (task.generalStatus !== 'open') {
      throw new IClassTaskNotOpenError(taskId);
    }

    // Step 5: Validate resultCode against catalog
    const rcEntry = await this.resultCodeRepo.findByCode(resultCode);
    if (!rcEntry) {
      throw new IClassResultCodeNotFoundError(resultCode);
    }

    // Step 6: Live pre-check (AD-1) — OS state in IClass
    const snapshot = await this.iclass.getServiceOrder(task.iclassOrderCode);
    if (!snapshot) {
      throw new IClassNoServiceOrderError(`IClass does not recognize order "${task.iclassOrderCode}"`);
    }
    if (snapshot.statusCode === '7') {
      throw new IClassAlreadyClosedError(task.iclassOrderCode);
    }

    // Step 7: Push close to IClass (AD-2 — dumb transport, errors propagate).
    // statusCode '50' = Aprovação: the technician already closed it in the field app;
    // pushing would be rejected (ICLERR_0212). Skip the push, close LOCAL only.
    if (snapshot.statusCode !== ICLASS_STATUS_PENDING_APPROVAL) {
      const closeInput: CloseServiceOrderInput = {
        serviceOrderCode: task.iclassOrderCode,
        resultCode,
        closeDate: closeDate ?? new Date(),
        commentary,
      };
      try {
        await this.iclass.closeServiceOrder(closeInput);
      } catch (error) {
        // Every operational result code (Cliente Ausente, Instalacion Completa, Tarea
        // No Factible, ...) is rejected by IClass: ICLERR_0216 (not associated to the
        // SO type) or ICLERR_0217 (its survey has mandatory questions). Retry ONCE with
        // the survey-free code created specifically for closing from Prominense. The
        // LOCAL closure below still records the operator's ORIGINAL resultCode.
        if (!isResultCodeRejection(error)) throw error;
        const trimmedCommentary = commentary.trim();
        // A 'Sucesso' operator code (Instalacion Completa, ...) falls back to the
        // COMPLETADA code; anything else (Falha — Cliente Ausente, Tarea No Factible, ...)
        // falls back to CANCELADA. The LOCAL closure below still keeps the operator's
        // ORIGINAL resultCode regardless of which fallback was pushed.
        // An empty catalog read falls back to CANCELADA: recording a success in IClass for
        // work that may have failed is the damaging side.
        const rows = await this.catalogRowsFor(resultCode);
        const fallbackCode = rows.length > 0 && rows.every(r => r.type === 'Sucesso')
          ? ICLASS_COMPLETED_IN_PROMINENSE
          : ICLASS_CANCELLED_IN_PROMINENSE;
        await this.iclass.closeServiceOrder({
          ...closeInput,
          resultCode: fallbackCode,
          commentary: trimmedCommentary
            ? `${trimmedCommentary} (motivo elegido en Prominense: ${resultCode})`
            : `(motivo elegido en Prominense: ${resultCode})`,
        });
      }
    }

    // Step 8: Close locally via the atomic guard (origin=staff).
    const actor: ActorContext = { actorId, actorName: actorId ?? 'System' };
    const closeResult = await applyTaskClosure(this.schedulingRepo, this.recorder, {
      taskId,
      origin: 'staff',
      resultCode,
      closedByUserId: actorId,
    });
    let updated = closeResult.task ?? await this.schedulingRepo.getTask(taskId);
    if (closeResult.closed && this.recorder) {
      await this.recorder.record(taskId, 'status_changed', {
        actor,
        fromValue: task.generalStatus,
        toValue: 'closed',
      });
    }

    // Move the task to the operator's own mapped stage — ONLY on a WIN, so a failure code
    // (e.g. Cliente Ausente → Ausente stage) lands there instead of staying parked in the
    // in-flight stage for the cron to reinterpret. Forward-only, so it never drags a task
    // backwards nor into another workflow; best-effort, because the close already happened
    // in IClass and locally, and a stage problem must not report it as failed.
    if (closeResult.closed) {
      const stageId = await this.unambiguousStageFor(resultCode);
      if (stageId) {
        try {
          const { moved } = await this.schedulingRepo.moveTaskToStageIfForward(taskId, stageId);
          if (moved) updated = (await this.schedulingRepo.getTask(taskId)) ?? updated;
          else if (updated?.stageId !== stageId) {
            // eslint-disable-next-line no-console
            console.warn(`[iclass-close] task ${taskId}: stage ${stageId} not applied (backwards or another workflow)`);
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`[iclass-close] task ${taskId}: stage move to ${stageId} failed (close already done):`, error);
        }
      }
    }

    return updated ?? task;
  }

  /**
   * The catalog holds one row per (soTypeId, code) and `findByCode` returns an arbitrary
   * one, so every decision derived from the code reads ALL of its rows instead.
   */
  private async catalogRowsFor(code: string) {
    const target = normalizeResultCode(code);
    return (await this.resultCodeRepo.list()).filter(r => normalizeResultCode(r.code) === target);
  }

  /** The mapped stage only when every row of this code agrees on it. */
  private async unambiguousStageFor(code: string): Promise<string | null> {
    const stages = new Set((await this.catalogRowsFor(code)).map(r => r.mappedStageId).filter((id): id is string => !!id));
    return stages.size === 1 ? [...stages][0]! : null;
  }
}

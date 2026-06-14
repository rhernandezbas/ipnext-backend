import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { IClassPort, CloseServiceOrderInput } from '@domain/ports/IClassPort';
import { IClassResultCodeRepository } from '@domain/ports/IClassResultCodeRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { ScheduledTask } from '@domain/entities/scheduling';
import { TaskNotFoundError } from '@domain/errors/scheduling';
import {
  IClassActionDisabledError,
  IClassTaskNotOpenError,
  IClassAlreadyClosedError,
  IClassNoServiceOrderError,
  IClassResultCodeNotFoundError,
} from '@domain/errors/iclass';

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
 * 8. setGeneralStatus='closed' locally + record 'status_changed'
 *    Guard: task.generalStatus === 'open' is already enforced at step 4; no extra
 *    guard needed here (the check at step 4 is the idempotency fence — AD-6).
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

    // Step 7: Push close to IClass (AD-2 — dumb transport, errors propagate)
    const closeInput: CloseServiceOrderInput = {
      serviceOrderCode: task.iclassOrderCode,
      resultCode,
      closeDate: closeDate ?? new Date(),
      commentary,
    };
    await this.iclass.closeServiceOrder(closeInput);

    // Step 8: Set generalStatus='closed' locally
    // Note: task.generalStatus is 'open' at this point (verified at step 4)
    const actor: ActorContext = { actorId, actorName: actorId ?? 'System' };
    const updated = await this.schedulingRepo.updateTask(taskId, { generalStatus: 'closed' });
    if (updated && this.recorder) {
      await this.recorder.record(taskId, 'status_changed', {
        actor,
        fromValue: task.generalStatus,
        toValue: 'closed',
      });
    }
    return updated ?? task;
  }
}

/**
 * ResendTaskToIClassWithNode — use case de reenvio manual a IClass con override de nodo.
 *
 * Recibe (taskId, nodeCode, actorId). Valida nodo contra listNodes(). Idempotente
 * si la tarea ya tiene iclassOrderCode. Registra IClassDispatchAttempt en TODO intento
 * (exito y fallo). Reusa dispatchToIClass para no duplicar la logica de envio.
 *
 * Traza: REQ-RESEND-1..8, REQ-AUDIT-5, REQ-AUDIT-6.
 */
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { IClassPort } from '@domain/ports/IClassPort';
import { IClassDispatchAttemptRepository } from '@domain/ports/IClassDispatchAttemptRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { TaskNotFoundError, StageNotFoundError, MissingRequiredFieldsError } from '@domain/errors/scheduling';
import {
  IClassNodeNotFoundError,
  IClassRejectedError,
  IClassUnavailableError,
  MissingProjectForIClassError,
  MissingIClassMappingError,
} from '@domain/errors/iclass';
import { dispatchToIClass, recordAttempt } from './dispatchTaskToIClass';
import { IClassAutoAssigner } from '@domain/ports/IClassAutoAssigner';

const FLAG_KEY = 'iclass-integration';
const REGISTERED_IN_ICLASS_CODE = 'registered_in_iclass';

const REQUIRED_ORDER = ['customerName', 'phone', 'address', 'city', 'description'] as const;

function isBlank(v: string | null | undefined): boolean {
  return v == null || v.trim() === '';
}

/**
 * Normalizes a string for accent- and case-insensitive comparison.
 * Keeps in sync with SendTaskToIClass.norm().
 */
function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export class ResendTaskToIClassWithNode {
  constructor(
    private readonly tasks: SchedulingRepository,
    private readonly featureFlags: FeatureFlagRepository,
    private readonly iclass: IClassPort,
    private readonly attempts: IClassDispatchAttemptRepository,
    private readonly stageRepo: StageRepository,
    /** #130 — assign-at-register: best-effort auto-assigner. Optional. */
    private readonly autoAssigner?: IClassAutoAssigner,
  ) {}

  async execute(
    taskId: string,
    nodeCode: string,
    actorId: string | null,
  ): Promise<ScheduledTask> {
    // 1. Load task
    const task = await this.tasks.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // 2. Feature flag guard
    const flag = await this.featureFlags.get(FLAG_KEY);
    if (!flag?.enabled) {
      // Flag OFF: no reenvio possible — same behavior as SendTaskToIClass (no dispatch)
      return task;
    }

    // 3. Idempotency: already dispatched → return as-is (no new OS, no attempt)
    if (task.iclassOrderCode != null) {
      return task;
    }

    // 4. Resolve project + IClass SO type mapping
    if (task.projectId == null) {
      throw new MissingProjectForIClassError(taskId);
    }

    const mapping = await this.tasks.getTaskProjectMapping(taskId);
    if (!mapping || mapping.iclassSoType == null || !mapping.iclassSoType.active) {
      const projectTitle = mapping?.projectTitle ?? task.projectId;
      throw new MissingIClassMappingError(projectTitle);
    }

    // 5. Validate required fields
    const values: Record<(typeof REQUIRED_ORDER)[number], string | null> = {
      customerName: task.customerName,
      phone: task.customerPhone,
      address: task.address,
      city: task.customerCity,
      description: task.description,
    };
    const missingFields = REQUIRED_ORDER.filter(f => isBlank(values[f]));
    if (missingFields.length > 0) {
      throw new MissingRequiredFieldsError([...missingFields]);
    }

    // 6. Resolve workflowId from task.stageId
    const currentStage = await this.stageRepo.getById(task.stageId);
    if (!currentStage) throw new StageNotFoundError(task.stageId);
    const workflowId = currentStage.workflowId;

    // 7. Validate nodeCode against listNodes() — must exist exactly (or norm match)
    const nodes = await this.iclass.listNodes();
    const targetNorm = norm(nodeCode);
    const resolvedNode = nodes.find(n => norm(n.code) === targetNorm);

    if (!resolvedNode) {
      // Record attempt with node_not_found (REQ-AUDIT-5)
      await recordAttempt(this.attempts, {
        taskId,
        outcome: 'node_not_found',
        errorCode: 'ICLASS_NODE_NOT_FOUND',
        errorMessage: `No IClass node matches nodeCode "${nodeCode}"`,
        attemptedNodeCode: nodeCode,
        resolvedNodeCode: null,
        actorId,
      });
      throw new IClassNodeNotFoundError(nodeCode);
    }

    // 8. Dispatch (creates OS + setIClassOrderCode + moves to registered_in_iclass)
    //    The dispatchToIClass helper records the attempt on failure (best-effort).
    //    On success, we record the attempt ourselves below.
    try {
      const result = await dispatchToIClass(
        { tasks: this.tasks, iclass: this.iclass, attempts: undefined, autoAssigner: this.autoAssigner }, // attempts handled here
        task,
        mapping.iclassSoType.code,
        resolvedNode.code,
        { actorId, workflowId },
      );

      // Record success attempt (REQ-AUDIT-5 — resend audits ALL outcomes)
      await recordAttempt(this.attempts, {
        taskId,
        outcome: 'success',
        attemptedNodeCode: nodeCode,
        resolvedNodeCode: resolvedNode.code,
        actorId,
      });

      return result;
    } catch (err) {
      // dispatchToIClass already recorded the attempt with undefined attempts,
      // so we need to record here for ResendTaskToIClassWithNode which tracks all.
      // Determine outcome
      let outcome: 'rejected' | 'unavailable' | 'error' = 'error';
      let errCode = 'ICLASS_ERROR';

      if (err instanceof IClassRejectedError) {
        outcome = 'rejected';
        errCode = 'ICLASS_REJECTED';
      } else if (err instanceof IClassUnavailableError) {
        outcome = 'unavailable';
        errCode = 'ICLASS_UNAVAILABLE';
      }

      await recordAttempt(this.attempts, {
        taskId,
        outcome,
        errorCode: errCode,
        errorMessage: err instanceof Error ? err.message : String(err),
        attemptedNodeCode: resolvedNode.code,
        resolvedNodeCode: null,
        actorId,
      });

      throw err;
    }
  }
}

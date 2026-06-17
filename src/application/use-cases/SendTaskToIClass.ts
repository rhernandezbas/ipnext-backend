import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { IClassPort } from '@domain/ports/IClassPort';
import { IClassDispatchAttemptRepository } from '@domain/ports/IClassDispatchAttemptRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { NetworkSite } from '@domain/entities/networkSite';
import { MissingRequiredFieldsError, TaskNotFoundError, StageNotFoundError } from '@domain/errors/scheduling';
import {
  IClassNodeNotFoundError,
  IClassRejectedError,
  IClassUnavailableError,
  MissingProjectForIClassError,
  MissingIClassMappingError,
} from '@domain/errors/iclass';
import { dispatchToIClass, recordAttempt, NETWORK_PHONE, NETWORK_CUSTOMER_CODE } from './dispatchTaskToIClass';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';
import { IClassAutoAssigner } from '@domain/ports/IClassAutoAssigner';
import { SYSTEM_ACTOR } from './taskActivityActor';

const FLAG_KEY = 'iclass-integration';
/** Immutable business code for the "Registrado en IClass" stage. */
const REGISTERED_IN_ICLASS_CODE = 'registered_in_iclass';

/** Canonical order of the required fields surfaced to the front-end modal. */
const REQUIRED_ORDER = ['customerName', 'phone', 'address', 'city', 'description'] as const;

function isBlank(v: string | null | undefined): boolean {
  return v == null || v.trim() === '';
}

/** Primer valor NO-blank ('' cuenta como blank — NetworkSite.address es string, nunca null). */
function firstNonBlank(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) if (!isBlank(v)) return v!;
  return null;
}

/**
 * Normalizes a string for accent- and case-insensitive comparison:
 * trims, lowercases, and strips diacritics via NFD decomposition.
 */
function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Sends a task to IClass when it is moved to the "Enviar a IClass" stage.
 *
 * Behaviour (design Sequence):
 *  - flag OFF → move to the target stage unchanged, no IClass call.
 *  - already has iclassOrderCode → idempotent: move to "Registrado en IClass", no recreate.
 *  - task.projectId == null → MissingProjectForIClassError.
 *  - project.iclassSoType == null OR inactive → MissingIClassMappingError.
 *  - validates the 5 required fields → MissingRequiredFieldsError.
 *  - validates city against IClass nodes → IClassNodeNotFoundError.
 *  - creates the OS (no date) with soType from project mapping, persists orderCode, moves to "Registrado".
 *
 * Depends only on domain ports (DIP) — no infrastructure types.
 */
export class SendTaskToIClass {
  constructor(
    private readonly tasks: SchedulingRepository,
    private readonly featureFlags: FeatureFlagRepository,
    private readonly iclass: IClassPort,
    /** Optional audit repo (AD-6). Best-effort: failures are logged, not rethrown. */
    private readonly attempts?: IClassDispatchAttemptRepository,
    /** task-activity-log (#10 / D.15). Optional, best-effort. */
    private readonly recorder?: TaskActivityRecorder,
    /** network-node-task (#29): necesario para tareas de RED. */
    private readonly networkSiteRepo?: NetworkSiteRepository,
    /** #130 — assign-at-register: best-effort auto-assigner. Optional. */
    private readonly autoAssigner?: IClassAutoAssigner,
  ) {}

  /**
   * @param workflowId Workflow of the target ("Enviar a IClass") stage. Used to resolve the
   *   "Registrado en IClass" stage within the SAME workflow, avoiding homonym collisions.
   * @param actorId Optional — used for audit attempts on failure (AD-6). Null for automated flows.
   */
  async execute(
    taskId: string,
    targetStageId: string,
    workflowId?: string,
    actorId?: string | null,
    actor?: ActorContext,
  ): Promise<ScheduledTask> {
    const task = await this.tasks.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // 1. Feature flag OFF → plain move, no IClass. No attempt recorded (no dispatch).
    const flag = await this.featureFlags.get(FLAG_KEY);
    if (!flag?.enabled) {
      return this.move(taskId, targetStageId);
    }

    // 2. Idempotency: OS already created → just advance the stage. No attempt recorded.
    if (task.iclassOrderCode != null) {
      return this.moveToRegistrado(taskId, workflowId);
    }

    // 3. Resolve project + IClass SO type mapping (REQ-SCHED-1, REQ-SCHED-2, REQ-SCHED-3).
    if (task.projectId == null) {
      throw new MissingProjectForIClassError(taskId);
    }

    const mapping = await this.tasks.getTaskProjectMapping(taskId);
    if (!mapping || mapping.iclassSoType == null || !mapping.iclassSoType.active) {
      const projectTitle = mapping?.projectTitle ?? task.projectId;
      throw new MissingIClassMappingError(projectTitle);
    }

    // network-node-task (#29): branch por kind.
    const isNet = task.kind === 'network';
    let networkSite: NetworkSite | null = null;

    if (isNet) {
      // #66 — fibra tasks have no networkSiteId; skip site lookup entirely.
      const isFibra = task.networkType === 'fibra';

      if (!isFibra) {
        // 4-NET. RED: Resolver el sitio una sola vez para reusar en validación y dispatch.
        if (task.networkSiteId && this.networkSiteRepo) {
          networkSite = await this.networkSiteRepo.findById(task.networkSiteId) ?? null;
        }
      }

      // Validar required fields usando valores sustituidos (REQ-NODE-DISPATCH-2).
      // fibra: customerName=networkSiteName, address=task.address, city=iclassCityCode.
      // red: customerName=networkSiteName (JOIN), address=site.address??task.address, city=iclassCityCode??site.city.
      const effectiveCustomerName = task.networkSiteName ?? null;
      const effectivePhone        = NETWORK_PHONE;
      const effectiveAddress      = isFibra
        ? firstNonBlank(task.address, task.networkSiteName)
        : firstNonBlank(networkSite?.address, task.address);
      const effectiveCity         = isFibra
        ? (task.iclassCityCode ?? null)
        : firstNonBlank(task.iclassCityCode, networkSite?.city);

      const substitutedValues: Record<(typeof REQUIRED_ORDER)[number], string | null> = {
        customerName: effectiveCustomerName,
        phone: effectivePhone,
        address: effectiveAddress,
        city: effectiveCity,
        description: task.description,
      };
      const missingFields = REQUIRED_ORDER.filter(f => isBlank(substitutedValues[f]));
      if (missingFields.length > 0) {
        throw new MissingRequiredFieldsError([...missingFields]);
      }

      // 5-NET. fibra: nodeCode = iclassCityCode. red: iclassNodeCode del sitio (REQ-PORT-1).
      const resolvedNodeCode = isFibra
        ? (task.iclassCityCode ?? NETWORK_CUSTOMER_CODE)
        : (networkSite?.iclassNodeCode ?? NETWORK_CUSTOMER_CODE);

      // 6+7. Crear OS con campos sustituidos y avanzar de stage.
      try {
        const dispatched = await dispatchToIClass(
          { tasks: this.tasks, iclass: this.iclass, attempts: undefined, autoAssigner: this.autoAssigner },
          task,
          mapping.iclassSoType.code,
          resolvedNodeCode,
          { actorId, workflowId: workflowId!, networkSite },
        );
        if (this.recorder) {
          await this.recorder.record(taskId, 'sent_to_iclass', {
            actor: actor ?? SYSTEM_ACTOR,
            toValue: { iclassOrderCode: dispatched.iclassOrderCode },
            metadata: { stageId: targetStageId },
          });
        }
        return dispatched;
      } catch (err) {
        if (err instanceof IClassRejectedError) {
          await recordAttempt(this.attempts, {
            taskId,
            outcome: 'rejected',
            errorCode: 'ICLASS_REJECTED',
            errorMessage: err.message,
            attemptedNodeCode: resolvedNodeCode,
            resolvedNodeCode: null,
            actorId: actorId ?? null,
          });
        } else if (err instanceof IClassUnavailableError) {
          await recordAttempt(this.attempts, {
            taskId,
            outcome: 'unavailable',
            errorCode: 'ICLASS_UNAVAILABLE',
            errorMessage: err.message,
            attemptedNodeCode: resolvedNodeCode,
            resolvedNodeCode: null,
            actorId: actorId ?? null,
          });
        }
        throw err;
      }
    }

    // 4. Validate the 5 required fields (in canonical order) — CUSTOMER path.
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

    // 5. Resolve the node by city against IClass (case- and accent-insensitive, trimmed).
    const target = norm(task.customerCity!);
    const nodes = await this.iclass.listNodes();
    const node = nodes.find(n => norm(n.code) === target);
    if (!node) {
      // Audit: record node_not_found (best-effort, non-fatal — AD-7, AD-6)
      await recordAttempt(this.attempts, {
        taskId,
        outcome: 'node_not_found',
        errorCode: 'ICLASS_NODE_NOT_FOUND',
        errorMessage: `No IClass node matches city "${task.customerCity}"`,
        attemptedNodeCode: null,
        resolvedNodeCode: null,
        actorId: actorId ?? null,
      });
      throw new IClassNodeNotFoundError(task.customerCity!);
    }

    // 6+7. Create OS, persist orderCode, advance to registered_in_iclass via shared helper.
    //      Pass attempts=undefined so the helper records nothing on failure — we audit below.
    //      SUCCESS is NOT audited (AD-7).
    try {
      const dispatched = await dispatchToIClass(
        { tasks: this.tasks, iclass: this.iclass, attempts: undefined, autoAssigner: this.autoAssigner },
        task,
        mapping.iclassSoType.code, // resolved from project mapping (REQ-SCHED-4)
        node.code,
        { actorId, workflowId: workflowId! },
      );
      // task-activity-log (#10 / D.15): OS created successfully → emit `sent_to_iclass`.
      if (this.recorder) {
        await this.recorder.record(taskId, 'sent_to_iclass', {
          actor: actor ?? SYSTEM_ACTOR,
          toValue: { iclassOrderCode: dispatched.iclassOrderCode },
          metadata: { stageId: targetStageId },
        });
      }
      return dispatched;
    } catch (err) {
      // Audit failure (best-effort — AD-6). Re-throw the original domain error.
      if (err instanceof IClassRejectedError) {
        await recordAttempt(this.attempts, {
          taskId,
          outcome: 'rejected',
          errorCode: 'ICLASS_REJECTED',
          errorMessage: err.message,
          attemptedNodeCode: node.code,
          resolvedNodeCode: null,
          actorId: actorId ?? null,
        });
      } else if (err instanceof IClassUnavailableError) {
        await recordAttempt(this.attempts, {
          taskId,
          outcome: 'unavailable',
          errorCode: 'ICLASS_UNAVAILABLE',
          errorMessage: err.message,
          attemptedNodeCode: node.code,
          resolvedNodeCode: null,
          actorId: actorId ?? null,
        });
      }
      throw err;
    }
  }

  private async move(taskId: string, stageId: string): Promise<ScheduledTask> {
    const moved = await this.tasks.moveTaskToStage(taskId, stageId);
    if (!moved) throw new TaskNotFoundError(taskId);
    return moved;
  }

  private async moveToRegistrado(taskId: string, workflowId?: string): Promise<ScheduledTask> {
    const stage = await this.tasks.getStageByCode(REGISTERED_IN_ICLASS_CODE, workflowId!);
    if (!stage) throw new StageNotFoundError(REGISTERED_IN_ICLASS_CODE);
    return this.move(taskId, stage.id);
  }
}

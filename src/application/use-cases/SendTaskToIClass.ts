import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { IClassPort } from '@domain/ports/IClassPort';
import { ScheduledTask } from '@domain/entities/scheduling';
import { MissingRequiredFieldsError, TaskNotFoundError, StageNotFoundError } from '@domain/errors/scheduling';
import {
  IClassNodeNotFoundError,
  MissingProjectForIClassError,
  MissingIClassMappingError,
} from '@domain/errors/iclass';

const FLAG_KEY = 'iclass-integration';
/** Immutable business code for the "Registrado en IClass" stage. */
const REGISTERED_IN_ICLASS_CODE = 'registered_in_iclass';

/** Canonical order of the required fields surfaced to the front-end modal. */
const REQUIRED_ORDER = ['customerName', 'phone', 'address', 'city', 'description'] as const;

function isBlank(v: string | null | undefined): boolean {
  return v == null || v.trim() === '';
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
  ) {}

  /**
   * @param workflowId Workflow of the target ("Enviar a IClass") stage. Used to resolve the
   *   "Registrado en IClass" stage within the SAME workflow, avoiding homonym collisions.
   */
  async execute(taskId: string, targetStageId: string, workflowId?: string): Promise<ScheduledTask> {
    const task = await this.tasks.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // 1. Feature flag OFF → plain move, no IClass.
    const flag = await this.featureFlags.get(FLAG_KEY);
    if (!flag?.enabled) {
      return this.move(taskId, targetStageId);
    }

    // 2. Idempotency: OS already created → just advance the stage.
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

    // 4. Validate the 5 required fields (in canonical order).
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
    if (!node) throw new IClassNodeNotFoundError(task.customerCity!);

    // 6. Create the OS (no scheduledDate). Failure propagates IClassUnavailableError.
    const { orderCode } = await this.iclass.createServiceOrder({
      soCode: String(task.sequenceNumber),
      customerCode: task.customerCode!,
      customerName: task.customerName!,
      phone: task.customerPhone!,
      address: task.address!,
      city: task.customerCity!,
      description: task.description!,
      soType: mapping.iclassSoType.code, // resolved from project mapping (REQ-SCHED-4)
    });

    // 7. Persist the orderCode + advance the stage.
    await this.tasks.setIClassOrderCode(taskId, orderCode);
    return this.moveToRegistrado(taskId, workflowId);
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

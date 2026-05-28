import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { IClassPort } from '@domain/ports/IClassPort';
import { ScheduledTask } from '@domain/entities/scheduling';
import { MissingRequiredFieldsError, TaskNotFoundError, StageNotFoundError } from '@domain/errors/scheduling';
import { IClassNodeNotFoundError } from '@domain/errors/iclass';

const FLAG_KEY = 'iclass-integration';
const REGISTRADO_STAGE_NAME = 'Registrado en IClass';

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
 *  - validates the 5 required fields → MissingRequiredFieldsError.
 *  - validates city against IClass nodes → IClassNodeNotFoundError.
 *  - creates the OS (no date), persists the orderCode, moves to "Registrado en IClass".
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

    // 3. Validate the 5 required fields (in canonical order).
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

    // 4. Resolve the node by city against IClass (case- and accent-insensitive, trimmed).
    const target = norm(task.customerCity!);
    const nodes = await this.iclass.listNodes();
    const node = nodes.find(n => norm(n.code) === target);
    if (!node) throw new IClassNodeNotFoundError(task.customerCity!);

    // 5. Create the OS (no scheduledDate). Failure propagates IClassUnavailableError.
    // TODO (FASE 3): replace soType with mapping.iclassSoType.code after inserting
    // the project-mapping resolution block above this step.
    const { orderCode } = await this.iclass.createServiceOrder({
      soCode: String(task.sequenceNumber),
      customerCode: task.customerCode!,
      customerName: task.customerName!,
      phone: task.customerPhone!,
      address: task.address!,
      city: task.customerCity!,
      description: task.description!,
      soType: '', // placeholder — resolved from project mapping in FASE 3
    });

    // 6. Persist the orderCode + advance the stage.
    await this.tasks.setIClassOrderCode(taskId, orderCode);
    return this.moveToRegistrado(taskId, workflowId);
  }

  private async move(taskId: string, stageId: string): Promise<ScheduledTask> {
    const moved = await this.tasks.moveTaskToStage(taskId, stageId);
    if (!moved) throw new TaskNotFoundError(taskId);
    return moved;
  }

  private async moveToRegistrado(taskId: string, workflowId?: string): Promise<ScheduledTask> {
    const stage = await this.tasks.getStageByName(REGISTRADO_STAGE_NAME, workflowId);
    if (!stage) throw new StageNotFoundError(REGISTRADO_STAGE_NAME);
    return this.move(taskId, stage.id);
  }
}

import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { CampaignTaskTransitionPort, TaskTransitionOutcome } from '@domain/ports/CampaignTaskTransitionPort';
import { MoveTaskToStage } from '../MoveTaskToStage';
import { SYSTEM_ACTOR } from '../taskActivityActor';

/** Immutable business code for the IClass-triggering stage — forbidden as transition target. */
const SEND_TO_ICLASS_CODE = 'send_to_iclass';

/**
 * bulk-task-stage-transition (D4, TRANS-1..3) — implementación del port de transición.
 * Compone:
 *  - **Guard still-in-A (TRANS-2):** solo mueve si la tarea SIGUE en su estado de origen A
 *    (si un humano la movió entre create y send, no-op). Respeta la intervención humana.
 *  - **Guard anti-send_to_iclass (TRANS-3):** red de seguridad — si el destino B resultara
 *    `send_to_iclass` (config vieja / carrera), NO mueve (evita crear una OS en IClass).
 *  - Reusa `MoveTaskToStage` (registra `stage_changed` en el feed con el actor sistema →
 *    rastro auditable "movida por el envío bulk").
 *
 * NO lanza en los caminos de guard (devuelve el outcome); un error REAL (DB) sí propaga y lo
 * atrapa el llamador aislado en `SendCampaign` (TRANS-1, jamás re-marca `failed`).
 */
export class TransitionTaskAfterSend implements CampaignTaskTransitionPort {
  constructor(
    private readonly tasks: SchedulingRepository,
    private readonly stages: StageRepository,
    private readonly moveTaskToStage: MoveTaskToStage,
  ) {}

  async transition(input: { taskId: string; fromStageId: string; toStageId: string }): Promise<TaskTransitionOutcome> {
    const task = await this.tasks.getTask(input.taskId);
    // TRANS-2 — la tarea ya no existe, o ya no está en A (un humano la movió) → no-op.
    if (!task || task.stageId !== input.fromStageId) return 'skipped_not_in_origin';

    // TRANS-3 — red de seguridad: NUNCA disparar el flujo de OS de IClass desde el bulk.
    const target = await this.stages.getById(input.toStageId);
    if (target?.code === SEND_TO_ICLASS_CODE) return 'skipped_iclass';

    await this.moveTaskToStage.execute(input.taskId, input.toStageId, SYSTEM_ACTOR);
    return 'moved';
  }
}

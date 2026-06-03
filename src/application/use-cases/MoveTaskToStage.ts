import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { StageNotFoundError, TaskNotFoundError } from '@domain/errors/scheduling';
import { SendTaskToIClass } from './SendTaskToIClass';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

/** Immutable business code for the stage that triggers the IClass service-order flow. */
const SEND_TO_ICLASS_CODE = 'send_to_iclass';

export class MoveTaskToStage {
  constructor(
    private readonly tasks: SchedulingRepository,
    private readonly stages: StageRepository,
    // Optional: when injected, moving to "Enviar a IClass" delegates the OS creation.
    // Left optional so the wiring (app.ts) can be completed in Fase 4 without breaking this use case.
    private readonly sendTaskToIClass?: SendTaskToIClass,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(taskId: string, stageId: string, actor?: ActorContext): Promise<ScheduledTask> {
    const stage = await this.stages.getById(stageId);
    if (!stage) throw new StageNotFoundError(stageId);

    // Hook: moving to the "send_to_iclass" stage delegates to the dedicated use case (AD-1).
    // Uses stage.code (immutable) so the trigger is rename-safe (REQ-MOVE-STAGE-1).
    // Snapshot the current stage BEFORE moving — both branches need it for the diff.
    const fromStageId = this.recorder ? (await this.tasks.getTask(taskId))?.stageId ?? null : null;

    if (this.sendTaskToIClass && stage.code === SEND_TO_ICLASS_CODE) {
      // Record the user-initiated `stage_changed` BEFORE delegating, so the feed shows
      // `stage_changed` then `sent_to_iclass` in that order (spec REQ-MODEL-1). The
      // delegate emits its own `sent_to_iclass` after creating the OS.
      await this.recordStageChange(taskId, fromStageId, stageId, stage.name, actor);
      // Pass the target stage's workflow so "Registrado en IClass" is resolved
      // within the SAME workflow (avoids homonym collisions across workflows).
      return this.sendTaskToIClass.execute(taskId, stageId, stage.workflowId, actor?.actorId ?? null, actor);
    }

    const updated = await this.tasks.moveTaskToStage(taskId, stageId);
    if (!updated) throw new TaskNotFoundError(taskId);

    await this.recordStageChange(taskId, fromStageId, stageId, stage.name, actor);

    return updated;
  }

  /** Emit `stage_changed` (#10 / D.3) when the task actually leaves its prior stage. No-op without a recorder. */
  private async recordStageChange(
    taskId: string,
    fromStageId: string | null,
    toStageId: string,
    toStageName: string,
    actor?: ActorContext,
  ): Promise<void> {
    if (!this.recorder || !fromStageId || fromStageId === toStageId) return;
    const fromStage = await this.stages.getById(fromStageId);
    await this.recorder.record(taskId, 'stage_changed', {
      actor: actor ?? SYSTEM_ACTOR,
      fromValue: fromStageId,
      toValue: toStageId,
      metadata: {
        fromStageId,
        toStageId,
        fromStageName: fromStage?.name ?? null,
        toStageName,
      },
    });
  }
}

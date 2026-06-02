import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { StageNotFoundError, TaskNotFoundError } from '@domain/errors/scheduling';
import { SendTaskToIClass } from './SendTaskToIClass';

/** Immutable business code for the stage that triggers the IClass service-order flow. */
const SEND_TO_ICLASS_CODE = 'send_to_iclass';

export class MoveTaskToStage {
  constructor(
    private readonly tasks: SchedulingRepository,
    private readonly stages: StageRepository,
    // Optional: when injected, moving to "Enviar a IClass" delegates the OS creation.
    // Left optional so the wiring (app.ts) can be completed in Fase 4 without breaking this use case.
    private readonly sendTaskToIClass?: SendTaskToIClass,
  ) {}

  async execute(taskId: string, stageId: string): Promise<ScheduledTask> {
    const stage = await this.stages.getById(stageId);
    if (!stage) throw new StageNotFoundError(stageId);

    // Hook: moving to the "send_to_iclass" stage delegates to the dedicated use case (AD-1).
    // Uses stage.code (immutable) so the trigger is rename-safe (REQ-MOVE-STAGE-1).
    if (this.sendTaskToIClass && stage.code === SEND_TO_ICLASS_CODE) {
      // Pass the target stage's workflow so "Registrado en IClass" is resolved
      // within the SAME workflow (avoids homonym collisions across workflows).
      return this.sendTaskToIClass.execute(taskId, stageId, stage.workflowId);
    }

    const updated = await this.tasks.moveTaskToStage(taskId, stageId);
    if (!updated) throw new TaskNotFoundError(taskId);
    return updated;
  }
}

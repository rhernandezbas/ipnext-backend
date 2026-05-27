import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { StageNotFoundError, TaskNotFoundError } from '@domain/errors/scheduling';
import { SendTaskToIClass } from './SendTaskToIClass';

/** Stage name that triggers the IClass service-order flow. */
const ENVIAR_A_ICLASS_STAGE_NAME = 'Enviar a IClass';

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

    // Hook: moving to "Enviar a IClass" delegates to the dedicated use case (AD-1).
    if (this.sendTaskToIClass && stage.name === ENVIAR_A_ICLASS_STAGE_NAME) {
      return this.sendTaskToIClass.execute(taskId, stageId);
    }

    const updated = await this.tasks.moveTaskToStage(taskId, stageId);
    if (!updated) throw new TaskNotFoundError(taskId);
    return updated;
  }
}

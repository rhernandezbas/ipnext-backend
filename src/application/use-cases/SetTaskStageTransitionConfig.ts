import { MappedStage } from '@domain/ports/TaskStageRecipientConfigRepository';
import { TaskStageTransitionConfigRepository } from '@domain/ports/TaskStageTransitionConfigRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { ResultingStageNotAllowedError, TaskStageNotFoundError } from '@domain/errors/messaging-task-stage-config';

export interface SetTaskStageTransitionConfigInput {
  stageId: string | null;
}

/** Immutable business code for the IClass-triggering stage — forbidden as transition target. */
const SEND_TO_ICLASS_CODE = 'send_to_iclass';

/**
 * bulk-task-stage-transition (B1.6, TTC-2/TTC-3, decisión 7) — setea el estado
 * resultante ÚNICO GLOBAL (o lo limpia con `null`). Valida ANTES de persistir
 * (fail-loud, todo-o-nada): (1) el `stageId` debe corresponder a un `Stage`
 * existente; (2) su `code` NO puede ser `send_to_iclass` (crearía OS masivas en
 * IClass al mover). Un `null` limpia sin validar (des-configurar la transición).
 */
export class SetTaskStageTransitionConfig {
  constructor(
    private readonly config: TaskStageTransitionConfigRepository,
    private readonly stages: StageRepository,
  ) {}

  async execute(input: SetTaskStageTransitionConfigInput): Promise<{ resultingStage: MappedStage | null }> {
    if (input.stageId !== null) {
      const stage = await this.stages.getById(input.stageId);
      if (!stage) {
        throw new TaskStageNotFoundError(
          `resultingStageId '${input.stageId}' no corresponde a un Stage existente`,
        );
      }
      if (stage.code === SEND_TO_ICLASS_CODE) {
        throw new ResultingStageNotAllowedError(input.stageId);
      }
    }
    await this.config.setResultingStageId(input.stageId);
    return { resultingStage: await this.config.getResultingStage() };
  }
}

import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { ScheduledTask, TaskStatus } from '@domain/entities/scheduling';
import { MoveTaskToStage } from './MoveTaskToStage';

/**
 * @deprecated Use MoveTaskToStage directly. This shim maps legacy status values
 * to the Default workflow stages and delegates to MoveTaskToStage.
 * Will be removed in the next change after scheduling-foundation-stage-model.
 */
export class UpdateTaskStatus {
  private readonly moveTaskToStage: MoveTaskToStage;

  constructor(
    private readonly repo: SchedulingRepository,
    private readonly stages: StageRepository,
  ) {
    this.moveTaskToStage = new MoveTaskToStage(repo, stages);
  }

  async execute(id: string, status: TaskStatus): Promise<ScheduledTask | null> {
    console.warn('deprecated: UpdateTaskStatus — use MoveTaskToStage with stageId instead');
    const stage = await this.stages.getDefaultWorkflowStageByLegacyStatus(status);
    if (!stage) {
      // Fall back to direct status update (should not happen in normal operation)
      return this.repo.updateTaskStatus(id, status);
    }
    try {
      return await this.moveTaskToStage.execute(id, stage.id);
    } catch {
      return null;
    }
  }
}

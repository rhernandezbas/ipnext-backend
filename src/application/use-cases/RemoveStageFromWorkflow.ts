import { StageRepository } from '@domain/ports/StageRepository';
import { StageNotFoundError, StageInUseError } from '@domain/errors/scheduling';

export class RemoveStageFromWorkflow {
  constructor(private readonly stages: StageRepository) {}

  async execute(workflowId: string, stageId: string): Promise<void> {
    const stage = await this.stages.getById(stageId);
    if (!stage || stage.workflowId !== workflowId) {
      throw new StageNotFoundError(stageId);
    }

    const taskCount = await this.stages.countTasksUsing(stageId);
    if (taskCount > 0) throw new StageInUseError(taskCount, stageId);

    await this.stages.remove(stageId);
  }
}

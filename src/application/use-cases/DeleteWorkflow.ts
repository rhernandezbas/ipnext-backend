import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import {
  WorkflowNotFoundError,
  WorkflowInUseError,
  DefaultWorkflowProtectedError,
} from '@domain/errors/scheduling';

export class DeleteWorkflow {
  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly stages: StageRepository,
  ) {}

  async execute(id: string): Promise<void> {
    const wf = await this.workflows.getById(id);
    if (!wf) throw new WorkflowNotFoundError(id);

    if (wf.name.toLowerCase() === 'default') {
      throw new DefaultWorkflowProtectedError();
    }

    const stageIds = wf.stages.map(s => s.id);
    if (stageIds.length > 0) {
      const taskCount = await this.stages.countTasksUsingAny(stageIds);
      if (taskCount > 0) throw new WorkflowInUseError(taskCount);
    }

    await this.workflows.delete(id);
  }
}

import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { Stage, StageCategory } from '@domain/entities/workflow';
import { WorkflowNotFoundError, StageNameConflictError } from '@domain/errors/scheduling';

export class AddStageToWorkflow {
  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly stages: StageRepository,
  ) {}

  async execute(workflowId: string, data: { name: string; category: StageCategory; order: number }): Promise<Stage> {
    const wf = await this.workflows.getById(workflowId);
    if (!wf) throw new WorkflowNotFoundError(workflowId);

    // Check for duplicate stage name (case-insensitive)
    const existing = wf.stages.find(s => s.name.toLowerCase() === data.name.toLowerCase());
    if (existing) throw new StageNameConflictError(data.name);

    return this.stages.add(workflowId, data);
  }
}

import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { Workflow } from '@domain/entities/workflow';
import { WorkflowNotFoundError } from '@domain/errors/scheduling';

export class GetWorkflow {
  constructor(private readonly repo: WorkflowRepository) {}

  async execute(id: string): Promise<Workflow> {
    const wf = await this.repo.getById(id);
    if (!wf) throw new WorkflowNotFoundError(id);
    return { ...wf, stages: [...wf.stages].sort((a, b) => a.order - b.order) };
  }
}

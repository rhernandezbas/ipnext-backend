import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { Workflow } from '@domain/entities/workflow';

export class ListWorkflows {
  constructor(private readonly repo: WorkflowRepository) {}

  async execute(): Promise<Workflow[]> {
    const workflows = await this.repo.list();
    return workflows.map(wf => ({
      ...wf,
      stages: [...wf.stages].sort((a, b) => a.order - b.order),
    }));
  }
}

import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { Workflow, Stage } from '@domain/entities/workflow';
import { WorkflowNameConflictError } from '@domain/errors/scheduling';

export class CreateWorkflow {
  constructor(private readonly repo: WorkflowRepository) {}

  async execute(data: {
    name: string;
    description?: string | null;
    stages?: Array<Pick<Stage, 'name' | 'category' | 'order'>>;
  }): Promise<Workflow> {
    const existing = await this.repo.getByName(data.name);
    if (existing) throw new WorkflowNameConflictError(data.name);

    const wf = await this.repo.create({
      name: data.name,
      description: data.description ?? null,
      stages: data.stages ?? [],
    });
    return { ...wf, stages: [...wf.stages].sort((a, b) => a.order - b.order) };
  }
}

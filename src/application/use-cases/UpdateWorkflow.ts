import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { Workflow } from '@domain/entities/workflow';
import { WorkflowNotFoundError, WorkflowNameConflictError } from '@domain/errors/scheduling';

export class UpdateWorkflow {
  constructor(private readonly repo: WorkflowRepository) {}

  async execute(id: string, data: { name?: string; description?: string | null }): Promise<Workflow> {
    const wf = await this.repo.getById(id);
    if (!wf) throw new WorkflowNotFoundError(id);

    if (data.name && data.name.toLowerCase() !== wf.name.toLowerCase()) {
      const conflict = await this.repo.getByName(data.name);
      if (conflict && conflict.id !== id) throw new WorkflowNameConflictError(data.name);
    }

    const updated = await this.repo.update(id, data);
    if (!updated) throw new WorkflowNotFoundError(id);
    return { ...updated, stages: [...updated.stages].sort((a, b) => a.order - b.order) };
  }
}

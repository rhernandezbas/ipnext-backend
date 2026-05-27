import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { Workflow } from '@domain/entities/workflow';
import { WorkflowNotFoundError, ReorderSetMismatchError } from '@domain/errors/scheduling';

export class ReorderStages {
  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly stages: StageRepository,
  ) {}

  async execute(workflowId: string, order: string[]): Promise<Workflow> {
    const wf = await this.workflows.getById(workflowId);
    if (!wf) throw new WorkflowNotFoundError(workflowId);

    // Use workflow.stages for set validation (source of truth across in-memory and Prisma)
    const current = wf.stages;
    const currentIds = [...current.map(s => s.id)].sort();
    const inputIds = [...order].sort();

    const hasDuplicates = new Set(order).size !== order.length;
    const lengthMismatch = currentIds.length !== inputIds.length;
    const contentMismatch = currentIds.some((id, i) => id !== inputIds[i]);

    if (hasDuplicates || lengthMismatch || contentMismatch) {
      throw new ReorderSetMismatchError();
    }

    // Apply reorder: try stageRepo first; if stages aren't there fall back to wf stages mutate
    const stagesInRepo = await this.stages.listByWorkflow(workflowId);
    if (stagesInRepo.length > 0) {
      await this.stages.reorder(workflowId, order);
    } else {
      // In-memory: workflow object already holds the stages — reorder them directly
      order.forEach((id, idx) => {
        const s = wf.stages.find(s => s.id === id);
        if (s) s.order = idx;
      });
      // Sort after mutation
      wf.stages.sort((a, b) => a.order - b.order);
    }

    return (await this.workflows.getById(workflowId))!;
  }
}

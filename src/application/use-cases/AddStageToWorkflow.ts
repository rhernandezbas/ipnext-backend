import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { Stage, StageCategory } from '@domain/entities/workflow';
import { WorkflowNotFoundError, StageNameConflictError } from '@domain/errors/scheduling';

/**
 * Generate a stable slug from a stage name.
 * Normalizes accents, lowercases, and collapses non-alphanumeric chars to '_'.
 * Falls back to 'stage' if the result is empty.
 */
export function slugifyStageCode(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'stage';
}

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

    // Auto-generate stable code from name, disambiguating within the workflow.
    const base = slugifyStageCode(data.name);
    const usedCodes = new Set(wf.stages.map(s => s.code));
    let code = base;
    let n = 1;
    while (usedCodes.has(code)) {
      n += 1;
      code = `${base}_${n}`;
    }

    return this.stages.add(workflowId, { ...data, code });
  }
}

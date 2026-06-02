import { WorkflowRepository } from '@domain/ports/WorkflowRepository';
import { Workflow, Stage } from '@domain/entities/workflow';
import { WorkflowNameConflictError } from '@domain/errors/scheduling';
import { slugifyStageCode } from './AddStageToWorkflow';

export class CreateWorkflow {
  constructor(private readonly repo: WorkflowRepository) {}

  async execute(data: {
    name: string;
    description?: string | null;
    stages?: Array<Pick<Stage, 'name' | 'category' | 'order'>>;
  }): Promise<Workflow> {
    const existing = await this.repo.getByName(data.name);
    if (existing) throw new WorkflowNameConflictError(data.name);

    // Auto-generate codes for stages (code is immutable, never from user input).
    const usedCodes = new Set<string>();
    const stagesWithCode = (data.stages ?? []).map(s => {
      const base = slugifyStageCode(s.name);
      let code = base;
      let n = 1;
      while (usedCodes.has(code)) { n += 1; code = `${base}_${n}`; }
      usedCodes.add(code);
      return { ...s, code };
    });

    const wf = await this.repo.create({
      name: data.name,
      description: data.description ?? null,
      stages: stagesWithCode,
    });
    return { ...wf, stages: [...wf.stages].sort((a, b) => a.order - b.order) };
  }
}

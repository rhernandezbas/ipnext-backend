import { StageRepository } from '@domain/ports/StageRepository';
import { Stage, StageCategory } from '@domain/entities/workflow';
import { StageNotFoundError, StageNameConflictError } from '@domain/errors/scheduling';

export interface UpdateStageInput {
  name?: string;
  category?: StageCategory;
}

export class UpdateStage {
  constructor(private readonly repo: StageRepository) {}

  async execute(stageId: string, input: UpdateStageInput): Promise<Stage> {
    const existing = await this.repo.getById(stageId);
    if (!existing) throw new StageNotFoundError(stageId);

    // Validate name uniqueness within the same workflow (only if name is changing)
    if (input.name !== undefined && input.name !== existing.name) {
      const siblings = await this.repo.listByWorkflow(existing.workflowId);
      const conflict = siblings.find(s => s.name === input.name && s.id !== stageId);
      if (conflict) throw new StageNameConflictError(input.name);
    }

    const updated = await this.repo.updateStage(stageId, {
      name: input.name,
      category: input.category,
    });
    if (!updated) throw new StageNotFoundError(stageId);
    return updated;
  }
}

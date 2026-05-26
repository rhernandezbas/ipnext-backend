import { StageRepository } from '@domain/ports/StageRepository';
import { Stage } from '@domain/entities/workflow';
import { StageNotFoundError } from '@domain/errors/scheduling';

export class UpdateStageColor {
  constructor(private readonly repo: StageRepository) {}
  async execute(stageId: string, color: string): Promise<Stage> {
    const existing = await this.repo.getById(stageId);
    if (!existing) throw new StageNotFoundError(stageId);
    const updated = await this.repo.updateColor(stageId, color);
    if (!updated) throw new StageNotFoundError(stageId);
    return updated;
  }
}

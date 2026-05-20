import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { StageRepository } from '@domain/ports/StageRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { StageNotFoundError, TaskNotFoundError } from '@domain/errors/scheduling';

export class MoveTaskToStage {
  constructor(
    private readonly tasks: SchedulingRepository,
    private readonly stages: StageRepository,
  ) {}

  async execute(taskId: string, stageId: string): Promise<ScheduledTask> {
    const stage = await this.stages.getById(stageId);
    if (!stage) throw new StageNotFoundError(stageId);
    const updated = await this.tasks.moveTaskToStage(taskId, stageId);
    if (!updated) throw new TaskNotFoundError(taskId);
    return updated;
  }
}

import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { TaskNotFoundError } from '@domain/errors/scheduling';

export class SetTaskInventoryReview {
  constructor(private readonly repo: SchedulingRepository) {}

  async execute(taskId: string, reviewed: boolean, actorId: string | null = null): Promise<ScheduledTask> {
    const updated = await this.repo.setInventoryReview(taskId, reviewed, actorId);
    if (!updated) throw new TaskNotFoundError(taskId);
    return updated;
  }
}

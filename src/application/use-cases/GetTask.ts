import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';

export class GetTask {
  constructor(private readonly repo: SchedulingRepository) {}

  execute(id: string): Promise<ScheduledTask | null> {
    return this.repo.getTask(id);
  }
}

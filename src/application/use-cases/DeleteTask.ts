import { SchedulingRepository } from '@domain/ports/SchedulingRepository';

export class DeleteTask {
  constructor(private readonly repo: SchedulingRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.deleteTask(id);
  }
}

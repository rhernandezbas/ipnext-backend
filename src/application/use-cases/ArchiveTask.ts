import { ScheduledTask } from '@domain/entities/scheduling';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskNotFoundError, TaskNotClosedError } from '@domain/errors/scheduling';

/**
 * #86 — Archive a task (set archivedAt = now).
 *
 * Precondition: task must be closed or dismissed (generalStatus !== 'open').
 * Idempotent: if already archived, returns the task unchanged.
 */
export class ArchiveTask {
  constructor(private readonly repo: SchedulingRepository) {}

  async execute(id: string): Promise<ScheduledTask> {
    const task = await this.repo.getTask(id);
    if (!task) throw new TaskNotFoundError(id);

    if (task.generalStatus === 'open') throw new TaskNotClosedError(id);

    // Idempotent: already archived — return as-is
    if (task.archivedAt !== null) return task;

    const updated = await this.repo.archiveTask(id);
    // archiveTask returns null only when task doesn't exist; we already checked above.
    return updated!;
  }
}

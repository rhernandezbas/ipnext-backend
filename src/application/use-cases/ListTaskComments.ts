import { TaskCommentRepository } from '@domain/ports/TaskCommentRepository';
import { TaskComment } from '@domain/entities/taskComment';

export class ListTaskComments {
  constructor(private readonly repo: TaskCommentRepository) {}

  execute(taskId: string): Promise<TaskComment[]> {
    return this.repo.listByTask(taskId);
  }
}

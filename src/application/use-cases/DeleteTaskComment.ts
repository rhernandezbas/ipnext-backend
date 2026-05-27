import { TaskCommentRepository } from '@domain/ports/TaskCommentRepository';

export class DeleteTaskComment {
  constructor(private readonly repo: TaskCommentRepository) {}

  execute(commentId: string): Promise<boolean> {
    return this.repo.delete(commentId);
  }
}

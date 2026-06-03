import { TaskCommentRepository } from '@domain/ports/TaskCommentRepository';
import { TaskComment } from '@domain/entities/taskComment';

export class InMemoryTaskCommentRepository implements TaskCommentRepository {
  private readonly store = new Map<string, TaskComment>();

  async listByTask(taskId: string): Promise<TaskComment[]> {
    return Array.from(this.store.values()).filter(c => c.taskId === taskId);
  }

  async getById(commentId: string): Promise<TaskComment | null> {
    return this.store.get(commentId) ?? null;
  }

  async create(comment: TaskComment): Promise<TaskComment> {
    this.store.set(comment.id, comment);
    return comment;
  }

  async delete(commentId: string): Promise<boolean> {
    return this.store.delete(commentId);
  }
}

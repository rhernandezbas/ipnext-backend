import { TaskComment } from '../entities/taskComment';

export interface TaskCommentRepository {
  listByTask(taskId: string): Promise<TaskComment[]>;
  /** Resolve a single comment (used to recover its taskId for the activity log). */
  getById(commentId: string): Promise<TaskComment | null>;
  create(comment: TaskComment): Promise<TaskComment>;
  delete(commentId: string): Promise<boolean>;
}

import { TaskComment } from '../entities/taskComment';

export interface TaskCommentRepository {
  listByTask(taskId: string): Promise<TaskComment[]>;
  create(comment: TaskComment): Promise<TaskComment>;
  delete(commentId: string): Promise<boolean>;
}

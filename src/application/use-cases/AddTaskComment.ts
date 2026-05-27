import { TaskCommentRepository } from '@domain/ports/TaskCommentRepository';
import { TaskComment, TaskCommentAttachment } from '@domain/entities/taskComment';
import { randomUUID } from 'crypto';

export interface AddTaskCommentInput {
  taskId: string;
  authorName: string;
  body: string;
  attachments: Array<{
    url: string;
    filename: string;
    mimeType?: string | null;
    sizeBytes?: number | null;
  }>;
}

export class AddTaskComment {
  constructor(private readonly repo: TaskCommentRepository) {}

  execute(input: AddTaskCommentInput): Promise<TaskComment> {
    const commentId = randomUUID();
    const attachments: TaskCommentAttachment[] = input.attachments.map(a => ({
      id: randomUUID(),
      commentId,
      url: a.url,
      filename: a.filename,
      mimeType: a.mimeType ?? null,
      sizeBytes: a.sizeBytes ?? null,
    }));

    const comment: TaskComment = {
      id: commentId,
      taskId: input.taskId,
      authorName: input.authorName,
      body: input.body,
      createdAt: new Date().toISOString(),
      attachments,
    };

    return this.repo.create(comment);
  }
}

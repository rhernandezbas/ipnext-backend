import { TaskCommentRepository } from '@domain/ports/TaskCommentRepository';
import { TaskComment, TaskCommentAttachment } from '@domain/entities/taskComment';
import { prisma } from '../../database/prisma';

function toAttachment(row: {
  id: string;
  commentId: string;
  url: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
}): TaskCommentAttachment {
  return {
    id: row.id,
    commentId: row.commentId,
    url: row.url,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
  };
}

function toComment(row: {
  id: string;
  taskId: string;
  authorName: string;
  body: string;
  createdAt: Date;
  attachments: Array<{
    id: string;
    commentId: string;
    url: string;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
  }>;
}): TaskComment {
  return {
    id: row.id,
    taskId: row.taskId,
    authorName: row.authorName,
    body: row.body,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    attachments: row.attachments.map(toAttachment),
  };
}

export class PrismaTaskCommentRepository implements TaskCommentRepository {
  async listByTask(taskId: string): Promise<TaskComment[]> {
    const rows = await prisma.taskComment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      include: { attachments: true },
    });
    return rows.map(toComment);
  }

  async create(comment: TaskComment): Promise<TaskComment> {
    const row = await prisma.taskComment.create({
      data: {
        id: comment.id,
        taskId: comment.taskId,
        authorName: comment.authorName,
        body: comment.body,
        attachments: {
          create: comment.attachments.map(a => ({
            id: a.id,
            url: a.url,
            filename: a.filename,
            mimeType: a.mimeType ?? null,
            sizeBytes: a.sizeBytes ?? null,
          })),
        },
      },
      include: { attachments: true },
    });
    return toComment(row);
  }

  async delete(commentId: string): Promise<boolean> {
    try {
      await prisma.taskComment.delete({ where: { id: commentId } });
      return true;
    } catch {
      return false;
    }
  }
}

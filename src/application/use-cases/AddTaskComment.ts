import { TaskCommentRepository } from '@domain/ports/TaskCommentRepository';
import { TaskComment, TaskCommentAttachment } from '@domain/entities/taskComment';
import { randomUUID } from 'crypto';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

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
  constructor(
    private readonly repo: TaskCommentRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(input: AddTaskCommentInput, actor?: ActorContext): Promise<TaskComment> {
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

    const created = await this.repo.create(comment);

    // task-activity-log (#10 / D.5): `commented` + one `attachment_added` per file.
    if (this.recorder) {
      const a = actor ?? SYSTEM_ACTOR;
      await this.recorder.record(input.taskId, 'commented', {
        actor: a,
        metadata: { commentId: created.id },
      });
      for (const att of created.attachments) {
        await this.recorder.record(input.taskId, 'attachment_added', {
          actor: a,
          metadata: { commentId: created.id, attachmentId: att.id },
        });
      }
    }

    return created;
  }
}

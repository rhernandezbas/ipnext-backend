import { TaskCommentRepository } from '@domain/ports/TaskCommentRepository';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';

export class DeleteTaskComment {
  constructor(
    private readonly repo: TaskCommentRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(commentId: string, actor?: ActorContext): Promise<boolean> {
    // The DELETE route carries no taskId, so resolve the comment first to recover
    // it for the activity log (#10 / D.6). Only read when a recorder is wired.
    const comment = this.recorder ? await this.repo.getById(commentId) : null;

    const deleted = await this.repo.delete(commentId);

    if (deleted && this.recorder && comment) {
      await this.recorder.record(comment.taskId, 'comment_deleted', {
        actor: actor ?? SYSTEM_ACTOR,
        metadata: { commentId },
      });
    }

    return deleted;
  }
}

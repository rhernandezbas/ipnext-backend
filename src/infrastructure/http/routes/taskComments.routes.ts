import { Router, Request, Response, RequestHandler } from 'express';
import { ListTaskComments } from '@application/use-cases/ListTaskComments';
import { AddTaskComment } from '@application/use-cases/AddTaskComment';
import { DeleteTaskComment } from '@application/use-cases/DeleteTaskComment';

/** Per-route permission guards (scheduling read/write/delete). */
export interface TaskCommentRoutePerms {
  read: RequestHandler;
  write: RequestHandler;
  delete: RequestHandler;
}

export function createTaskCommentsRouter(
  listComments: ListTaskComments,
  addComment: AddTaskComment,
  deleteComment: DeleteTaskComment,
  auth: RequestHandler,
  perms: TaskCommentRoutePerms,
): Router {
  const router = Router();

  // GET /api/scheduling/:taskId/comments
  router.get('/:taskId/comments', auth, perms.read, async (req: Request, res: Response): Promise<void> => {
    const comments = await listComments.execute(req.params['taskId'] as string);
    res.json(comments);
  });

  // POST /api/scheduling/:taskId/comments
  router.post('/:taskId/comments', auth, perms.write, async (req: Request, res: Response): Promise<void> => {
    const { body: commentBody, authorName, attachments } = req.body as {
      body: string;
      authorName: string;
      attachments?: Array<{ url: string; filename: string; mimeType?: string; sizeBytes?: number }>;
    };
    const comment = await addComment.execute({
      taskId: req.params['taskId'] as string,
      body: commentBody,
      authorName,
      attachments: attachments ?? [],
    });
    res.status(201).json(comment);
  });

  // DELETE /api/scheduling/comments/:commentId
  // NOTE: this sub-path must be registered on /api/scheduling so comments/:commentId
  // does not collide with /:taskId/comments — the caller mounts this router at /api/scheduling.
  router.delete('/comments/:commentId', auth, perms.delete, async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteComment.execute(req.params['commentId'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Comment not found', code: 'TASK_COMMENT_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}

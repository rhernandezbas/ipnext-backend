import { Router, Request, Response, NextFunction } from 'express';
import { GetClientComments } from '@application/use-cases/GetClientComments';
import { CreateClientComment } from '@application/use-cases/CreateClientComment';

export function createClientCommentsRouter(
  getComments: GetClientComments,
  createComment: CreateClientComment,
): Router {
  const router = Router();

  router.get('/:id/comments', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const comments = await getComments.execute(req.params['id'] as string);
      res.json(comments);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/comments', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { content, authorName } = req.body as { content: string; authorName: string };
      const comment = await createComment.execute(req.params['id'] as string, content, authorName);
      res.status(201).json(comment);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

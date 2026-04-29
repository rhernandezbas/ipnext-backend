import { Router, Request, Response } from 'express';
import { GetClientComments } from '@application/use-cases/GetClientComments';
import { CreateClientComment } from '@application/use-cases/CreateClientComment';

export function createClientCommentsRouter(
  getComments: GetClientComments,
  createComment: CreateClientComment,
): Router {
  const router = Router();

  router.get('/:id/comments', async (req: Request, res: Response): Promise<void> => {
    const comments = await getComments.execute(req.params['id'] as string);
    res.json(comments);
  });

  router.post('/:id/comments', async (req: Request, res: Response): Promise<void> => {
    const { content, authorName } = req.body as { content: string; authorName: string };
    const comment = await createComment.execute(req.params['id'] as string, content, authorName);
    res.status(201).json(comment);
  });

  return router;
}

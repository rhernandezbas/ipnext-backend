import { Router, Request, Response, NextFunction } from 'express';
import { ListMessages } from '@application/use-cases/ListMessages';
import { GetMessage } from '@application/use-cases/GetMessage';
import { CreateMessage } from '@application/use-cases/CreateMessage';
import { MarkMessageAsRead } from '@application/use-cases/MarkMessageAsRead';
import { DeleteMessage } from '@application/use-cases/DeleteMessage';
import { Message } from '@domain/entities/message';

export function createMessagesRouter(
  listMessages: ListMessages,
  getMessage: GetMessage,
  createMessage: CreateMessage,
  markAsRead: MarkMessageAsRead,
  deleteMessage: DeleteMessage,
): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const filter = req.query['filter'] as 'inbox' | 'sent' | 'draft' | undefined;
      const messages = await listMessages.execute(filter);
      res.json(messages);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const message = await getMessage.execute(req.params['id'] as string);
      if (!message) {
        res.status(404).json({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }
      res.json(message);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = req.body as Omit<Message, 'id' | 'createdAt'>;
      const message = await createMessage.execute({ ...data, status: 'sent' });
      res.status(201).json(message);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id/read', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const message = await markAsRead.execute(req.params['id'] as string);
      if (!message) {
        res.status(404).json({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }
      res.json(message);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deleted = await deleteMessage.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

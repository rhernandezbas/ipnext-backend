import { Router, Request, Response } from 'express';
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

  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const filter = req.query['filter'] as 'inbox' | 'sent' | 'draft' | undefined;
    const messages = await listMessages.execute(filter);
    res.json(messages);
  });

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const message = await getMessage.execute(req.params['id'] as string);
    if (!message) {
      res.status(404).json({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
      return;
    }
    res.json(message);
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const data = req.body as Omit<Message, 'id' | 'createdAt'>;
    const message = await createMessage.execute({ ...data, status: 'sent' });
    res.status(201).json(message);
  });

  router.patch('/:id/read', async (req: Request, res: Response): Promise<void> => {
    const message = await markAsRead.execute(req.params['id'] as string);
    if (!message) {
      res.status(404).json({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
      return;
    }
    res.json(message);
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteMessage.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}

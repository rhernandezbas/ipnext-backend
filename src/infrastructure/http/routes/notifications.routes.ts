import { Router, Request, Response } from 'express';
import { ListNotifications } from '@application/use-cases/ListNotifications';
import { MarkNotificationRead } from '@application/use-cases/MarkNotificationRead';
import { MarkAllNotificationsRead } from '@application/use-cases/MarkAllNotificationsRead';
import { DeleteNotification } from '@application/use-cases/DeleteNotification';

export function createNotificationsRouter(
  listNotifications: ListNotifications,
  markRead: MarkNotificationRead,
  markAllRead: MarkAllNotificationsRead,
  deleteNotification: DeleteNotification,
): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const unread = req.query['unread'] === 'true';
    const notifications = await listNotifications.execute(unread || undefined);
    res.json(notifications);
  });

  router.put('/read-all', async (_req: Request, res: Response): Promise<void> => {
    await markAllRead.execute();
    res.json({ success: true });
  });

  router.put('/:id/read', async (req: Request, res: Response): Promise<void> => {
    const notification = await markRead.execute(req.params['id'] as string);
    if (!notification) {
      res.status(404).json({ error: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' });
      return;
    }
    res.json(notification);
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const deleted = await deleteNotification.execute(req.params['id'] as string);
    if (!deleted) {
      res.status(404).json({ error: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' });
      return;
    }
    res.status(204).send();
  });

  return router;
}

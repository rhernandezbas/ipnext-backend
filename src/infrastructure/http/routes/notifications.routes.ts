import { Router, Request, Response, NextFunction } from 'express';
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

  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const unread = req.query['unread'] === 'true';
      const notifications = await listNotifications.execute(unread || undefined);
      res.json(notifications);
    } catch (err) {
      next(err);
    }
  });

  router.put('/read-all', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await markAllRead.execute();
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id/read', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const notification = await markRead.execute(req.params['id'] as string);
      if (!notification) {
        res.status(404).json({ error: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' });
        return;
      }
      res.json(notification);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deleted = await deleteNotification.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

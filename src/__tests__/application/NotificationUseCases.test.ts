import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryNotificationRepository } from '../../infrastructure/adapters/in-memory/InMemoryNotificationRepository';
import { ListNotifications } from '../../application/use-cases/ListNotifications';
import { MarkNotificationRead } from '../../application/use-cases/MarkNotificationRead';
import { MarkAllNotificationsRead } from '../../application/use-cases/MarkAllNotificationsRead';
import { DeleteNotification } from '../../application/use-cases/DeleteNotification';
import { createNotificationsRouter } from '../../infrastructure/http/routes/notifications.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  const repo = new InMemoryNotificationRepository();
  const listNotifications = new ListNotifications(repo);
  const markRead = new MarkNotificationRead(repo);
  const markAllRead = new MarkAllNotificationsRead(repo);
  const deleteNotification = new DeleteNotification(repo);
  app.use('/api/notifications', createNotificationsRouter(listNotifications, markRead, markAllRead, deleteNotification));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

describe('ListNotifications', () => {
  it('returns 12 notifications total', async () => {
    const repo = new InMemoryNotificationRepository();
    const uc = new ListNotifications(repo);
    const result = await uc.execute();
    expect(result).toHaveLength(12);
  });

  it('filtering unread returns 5 notifications', async () => {
    const repo = new InMemoryNotificationRepository();
    const uc = new ListNotifications(repo);
    const result = await uc.execute(true);
    expect(result).toHaveLength(5);
    expect(result.every(n => !n.read)).toBe(true);
  });
});

describe('MarkNotificationRead', () => {
  it('marks notification as read', async () => {
    const repo = new InMemoryNotificationRepository();
    const uc = new MarkNotificationRead(repo);
    const result = await uc.execute('notif-1');
    expect(result).not.toBeNull();
    expect(result?.read).toBe(true);
    expect(result?.readAt).not.toBeNull();
  });
});

describe('MarkAllNotificationsRead', () => {
  it('marks all notifications as read', async () => {
    const repo = new InMemoryNotificationRepository();
    const markAll = new MarkAllNotificationsRead(repo);
    const list = new ListNotifications(repo);
    await markAll.execute();
    const all = await list.execute();
    expect(all.every(n => n.read)).toBe(true);
  });
});

describe('GET /api/notifications', () => {
  it('returns 200', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(12);
  });
});

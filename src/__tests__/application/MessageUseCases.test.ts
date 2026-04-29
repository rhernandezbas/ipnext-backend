import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryMessageRepository } from '../../infrastructure/adapters/in-memory/InMemoryMessageRepository';
import { ListMessages } from '../../application/use-cases/ListMessages';
import { GetMessage } from '../../application/use-cases/GetMessage';
import { CreateMessage } from '../../application/use-cases/CreateMessage';
import { MarkMessageAsRead } from '../../application/use-cases/MarkMessageAsRead';
import { DeleteMessage } from '../../application/use-cases/DeleteMessage';
import { createMessagesRouter } from '../../infrastructure/http/routes/messages.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  const repo = new InMemoryMessageRepository();
  const listMessages = new ListMessages(repo);
  const getMessage = new GetMessage(repo);
  const createMessage = new CreateMessage(repo);
  const markAsRead = new MarkMessageAsRead(repo);
  const deleteMessage = new DeleteMessage(repo);
  app.use('/api/messages', createMessagesRouter(listMessages, getMessage, createMessage, markAsRead, deleteMessage));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

describe('ListMessages', () => {
  it('returns 8 total messages', async () => {
    const repo = new InMemoryMessageRepository();
    const uc = new ListMessages(repo);
    const result = await uc.execute();
    expect(result).toHaveLength(8);
  });

  it('filtering inbox returns unread messages', async () => {
    const repo = new InMemoryMessageRepository();
    const uc = new ListMessages(repo);
    const result = await uc.execute('inbox');
    expect(result.every(m => m.status === 'unread' || m.status === 'read')).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('CreateMessage', () => {
  it('creates message with status sent', async () => {
    const repo = new InMemoryMessageRepository();
    const uc = new CreateMessage(repo);
    const result = await uc.execute({
      subject: 'Test message',
      body: 'Hello world',
      fromId: 'admin-1',
      fromName: 'Admin',
      toId: 'client-1',
      toName: 'Client',
      clientId: 'client-1',
      channel: 'internal',
      status: 'sent',
      sentAt: new Date().toISOString(),
      threadId: null,
    });
    expect(result.status).toBe('sent');
    expect(result.id).toBeTruthy();
  });
});

describe('GET /api/messages', () => {
  it('returns 200', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/messages', () => {
  it('returns 201', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/messages')
      .send({
        subject: 'Nuevo mensaje',
        body: 'Contenido del mensaje',
        fromId: 'admin-1',
        fromName: 'Admin',
        toId: 'client-1',
        toName: 'Client',
        clientId: 'client-1',
        channel: 'internal',
        status: 'sent',
        sentAt: new Date().toISOString(),
        threadId: null,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
  });
});

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { GetClientComments } from '../../application/use-cases/GetClientComments';
import { CreateClientComment } from '../../application/use-cases/CreateClientComment';
import { InMemoryClientCommentRepository } from '../../infrastructure/adapters/in-memory/InMemoryClientCommentRepository';
import { createClientCommentsRouter } from '../../infrastructure/http/routes/clientComments.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryClientCommentRepository();
  const getComments = new GetClientComments(repo);
  const createComment = new CreateClientComment(repo);

  app.use('/api/customers', createClientCommentsRouter(getComments, createComment));

  // Error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/customers/:id/comments', () => {
  it('returns 200 with an empty array for a new client', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/customers/client-99/comments');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });
});

describe('POST /api/customers/:id/comments', () => {
  it('returns 201 with the created comment', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/customers/client-1/comments')
      .send({ content: 'Great client', authorName: 'Admin' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.clientId).toBe('client-1');
    expect(res.body.content).toBe('Great client');
    expect(res.body.authorName).toBe('Admin');
    expect(res.body.createdAt).toBeTruthy();
  });

  it('GET returns comments after a POST', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/customers/client-5/comments')
      .send({ content: 'First comment', authorName: 'Support' });

    const res = await request(app).get('/api/customers/client-5/comments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].content).toBe('First comment');
  });
});

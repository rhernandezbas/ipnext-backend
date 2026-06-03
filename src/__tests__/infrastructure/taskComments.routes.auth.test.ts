import request from 'supertest';
import express, { RequestHandler } from 'express';
import { AddTaskComment } from '@application/use-cases/AddTaskComment';
import { ListTaskComments } from '@application/use-cases/ListTaskComments';
import { DeleteTaskComment } from '@application/use-cases/DeleteTaskComment';
import { InMemoryTaskCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskCommentRepository';
import { createTaskCommentsRouter, TaskCommentRoutePerms } from '@infrastructure/http/routes/taskComments.routes';

const AUTH_PASS: RequestHandler = (req, _res, next) => { (req as unknown as { user: unknown }).user = { id: 'u1' }; next(); };
const AUTH_FAIL: RequestHandler = (_req, res) => { res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }); };
const PERM_PASS: RequestHandler = (_req, _res, next) => next();
const PERM_DENY: RequestHandler = (_req, res) => { res.status(403).json({ error: 'Forbidden', code: 'PERMISSION_DENIED' }); };

function buildApp(auth: RequestHandler, perms: TaskCommentRoutePerms) {
  const app = express();
  app.use(express.json());
  const repo = new InMemoryTaskCommentRepository();
  app.use('/api/scheduling', createTaskCommentsRouter(
    new ListTaskComments(repo),
    new AddTaskComment(repo),
    new DeleteTaskComment(repo),
    auth,
    perms,
  ));
  return app;
}
const allPass: TaskCommentRoutePerms = { read: PERM_PASS, write: PERM_PASS, delete: PERM_PASS };

describe('taskComments routes — auth/permission guards (F0)', () => {
  it('GET sin auth → 401', async () => {
    const res = await request(buildApp(AUTH_FAIL, allPass)).get('/api/scheduling/t1/comments');
    expect(res.status).toBe(401);
  });
  it('POST sin auth → 401', async () => {
    const res = await request(buildApp(AUTH_FAIL, allPass)).post('/api/scheduling/t1/comments').send({ body: 'x', authorName: 'a' });
    expect(res.status).toBe(401);
  });
  it('DELETE sin auth → 401', async () => {
    const res = await request(buildApp(AUTH_FAIL, allPass)).delete('/api/scheduling/comments/c1');
    expect(res.status).toBe(401);
  });
  it('GET autenticado sin scheduling.read → 403', async () => {
    const res = await request(buildApp(AUTH_PASS, { ...allPass, read: PERM_DENY })).get('/api/scheduling/t1/comments');
    expect(res.status).toBe(403);
  });
  it('POST autenticado sin scheduling.write → 403', async () => {
    const res = await request(buildApp(AUTH_PASS, { ...allPass, write: PERM_DENY })).post('/api/scheduling/t1/comments').send({ body: 'x', authorName: 'a' });
    expect(res.status).toBe(403);
  });
  it('DELETE autenticado sin scheduling.delete → 403', async () => {
    const res = await request(buildApp(AUTH_PASS, { ...allPass, delete: PERM_DENY })).delete('/api/scheduling/comments/c1');
    expect(res.status).toBe(403);
  });
  it('GET con scheduling.read → 200', async () => {
    const res = await request(buildApp(AUTH_PASS, allPass)).get('/api/scheduling/t1/comments');
    expect(res.status).toBe(200);
  });
  it('POST con scheduling.write → 201', async () => {
    const res = await request(buildApp(AUTH_PASS, allPass)).post('/api/scheduling/t1/comments').send({ body: 'hola', authorName: 'a' });
    expect(res.status).toBe(201);
  });
});

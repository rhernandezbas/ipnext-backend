import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { AddTaskComment } from '../../application/use-cases/AddTaskComment';
import { ListTaskComments } from '../../application/use-cases/ListTaskComments';
import { DeleteTaskComment } from '../../application/use-cases/DeleteTaskComment';
import { InMemoryTaskCommentRepository } from '../../infrastructure/adapters/in-memory/InMemoryTaskCommentRepository';
import { createTaskCommentsRouter } from '../../infrastructure/http/routes/taskComments.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryTaskCommentRepository();
  const addComment = new AddTaskComment(repo);
  const listComments = new ListTaskComments(repo);
  const deleteComment = new DeleteTaskComment(repo);

  app.use('/api/scheduling', createTaskCommentsRouter(listComments, addComment, deleteComment));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/scheduling/:taskId/comments', () => {
  it('returns 200 with an empty array for a task with no comments', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/scheduling/task-99/comments');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });
});

describe('POST /api/scheduling/:taskId/comments', () => {
  it('returns 201 with the created comment', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling/task-1/comments')
      .send({ body: 'Nice task', authorName: 'Admin', attachments: [] });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.taskId).toBe('task-1');
    expect(res.body.body).toBe('Nice task');
    expect(res.body.authorName).toBe('Admin');
    expect(res.body.createdAt).toBeTruthy();
    expect(Array.isArray(res.body.attachments)).toBe(true);
  });

  it('returns 201 with attachments metadata', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling/task-2/comments')
      .send({
        body: 'With attachment',
        authorName: 'Tech',
        attachments: [{ url: 'https://cdn.example.com/photo.jpg', filename: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 2048 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].url).toBe('https://cdn.example.com/photo.jpg');
  });

  it('GET returns comments after a POST', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/scheduling/task-5/comments')
      .send({ body: 'First comment', authorName: 'Support', attachments: [] });

    const res = await request(app).get('/api/scheduling/task-5/comments');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].body).toBe('First comment');
  });
});

describe('DELETE /api/scheduling/comments/:commentId', () => {
  it('returns 204 when the comment is deleted', async () => {
    const app = buildApp();

    const createRes = await request(app)
      .post('/api/scheduling/task-6/comments')
      .send({ body: 'To delete', authorName: 'Admin', attachments: [] });

    const commentId = createRes.body.id as string;
    const delRes = await request(app).delete(`/api/scheduling/comments/${commentId}`);

    expect(delRes.status).toBe(204);
  });

  it('returns 404 when the comment does not exist', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/scheduling/comments/nonexistent');

    expect(res.status).toBe(404);
  });
});

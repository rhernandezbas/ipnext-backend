/**
 * Integration tests for the ticket statuses catalog router.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryTicketStatusRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketStatusRepository';
import { ListTicketStatuses } from '../../application/use-cases/ListTicketStatuses';
import { GetTicketStatus } from '../../application/use-cases/GetTicketStatus';
import { CreateTicketStatus } from '../../application/use-cases/CreateTicketStatus';
import { UpdateTicketStatusCatalog } from '../../application/use-cases/UpdateTicketStatusCatalog';
import { DeleteTicketStatus } from '../../application/use-cases/DeleteTicketStatus';
import { createTicketStatusesRouter } from '../../infrastructure/http/routes/ticketStatuses.routes';
import type { AuthProvider } from '../../domain/ports/AuthProvider';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const repo = new InMemoryTicketStatusRepository();
  const listUC = new ListTicketStatuses(repo);
  const getUC = new GetTicketStatus(repo);
  const createUC = new CreateTicketStatus(repo);
  const updateUC = new UpdateTicketStatusCatalog(repo);
  const deleteUC = new DeleteTicketStatus(repo);

  const authProvider = {
    getSession: jest.fn().mockResolvedValue({ id: '1', email: 'admin@test.com', role: 'admin' }),
  } as unknown as AuthProvider;

  app.use(
    '/api/tickets/statuses',
    createTicketStatusesRouter(authProvider, undefined, listUC, getUC, createUC, updateUC, deleteUC),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, repo };
}

function withAuth(req: request.Test) {
  return req.set('Cookie', 'auth_token=mock-token');
}

describe('GET /api/tickets/statuses', () => {
  it('returns empty array initially', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).get('/api/tickets/statuses'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns statuses ordered by weight', async () => {
    const { app, repo } = buildApp();
    const createUC = new CreateTicketStatus(repo);
    await createUC.execute({ name: 'closed', color: '#94a3b8', weight: 3 });
    await createUC.execute({ name: 'open', color: '#22c55e', weight: 1 });

    const res = await withAuth(request(app).get('/api/tickets/statuses'));
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('open');
    expect(res.body[1].name).toBe('closed');
  });

  it('returns 401 without auth', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/tickets/statuses');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/tickets/statuses/:id', () => {
  it('returns the status when found', async () => {
    const { app, repo } = buildApp();
    const s = await new CreateTicketStatus(repo).execute({ name: 'open', color: '#22c55e', weight: 1 });

    const res = await withAuth(request(app).get(`/api/tickets/statuses/${s.id}`));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('open');
  });

  it('returns 404 when not found', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).get('/api/tickets/statuses/nonexistent'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_STATUS_NOT_FOUND');
  });
});

describe('POST /api/tickets/statuses', () => {
  it('creates a new status and returns 201', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).post('/api/tickets/statuses').send({ name: 'open', color: '#22c55e', weight: 1 }),
    );
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('open');
    expect(res.body.color).toBe('#22c55e');
    expect(res.body.id).toBeTruthy();
  });

  it('returns 400 when required fields are missing', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).post('/api/tickets/statuses').send({ name: 'open' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 409 when name already exists', async () => {
    const { app } = buildApp();
    await withAuth(
      request(app).post('/api/tickets/statuses').send({ name: 'open', color: '#22c55e', weight: 1 }),
    );
    const res = await withAuth(
      request(app).post('/api/tickets/statuses').send({ name: 'open', color: '#000', weight: 9 }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TICKET_STATUS_NAME_CONFLICT');
  });
});

describe('PUT /api/tickets/statuses/:id', () => {
  it('updates and returns the updated status', async () => {
    const { app, repo } = buildApp();
    const s = await new CreateTicketStatus(repo).execute({ name: 'open', color: '#22c55e', weight: 1 });

    const res = await withAuth(
      request(app).put(`/api/tickets/statuses/${s.id}`).send({ color: '#16a34a' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.color).toBe('#16a34a');
  });

  it('returns 404 when not found', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).put('/api/tickets/statuses/nonexistent').send({ color: '#000' }),
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_STATUS_NOT_FOUND');
  });

  it('returns 409 when name collides', async () => {
    const { app, repo } = buildApp();
    await new CreateTicketStatus(repo).execute({ name: 'open', color: '#22c55e', weight: 1 });
    const s = await new CreateTicketStatus(repo).execute({ name: 'pending', color: '#f59e0b', weight: 2 });

    const res = await withAuth(
      request(app).put(`/api/tickets/statuses/${s.id}`).send({ name: 'open' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TICKET_STATUS_NAME_CONFLICT');
  });
});

describe('DELETE /api/tickets/statuses/:id', () => {
  it('deletes an unused status and returns 204', async () => {
    const { app, repo } = buildApp();
    const s = await new CreateTicketStatus(repo).execute({ name: 'draft', color: '#000', weight: 9 });

    const res = await withAuth(request(app).delete(`/api/tickets/statuses/${s.id}`));
    expect(res.status).toBe(204);
  });

  it('returns 404 when not found', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).delete('/api/tickets/statuses/nonexistent'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_STATUS_NOT_FOUND');
  });

  it('returns 409 when status is in use', async () => {
    const { app, repo } = buildApp();
    const s = await new CreateTicketStatus(repo).execute({ name: 'open', color: '#22c55e', weight: 1 });
    repo.ticketCounts['open'] = 3;

    const res = await withAuth(request(app).delete(`/api/tickets/statuses/${s.id}`));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TICKET_STATUS_IN_USE');
  });
});

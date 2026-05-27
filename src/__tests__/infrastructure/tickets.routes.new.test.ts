/**
 * Integration tests for the new tickets router backed by InMemoryTicketRepository.
 * Tests the canónico contract: GET /api/tickets?customerId=X, POST, PATCH status, DELETE, etc.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { ListTickets } from '../../application/use-cases/ListTickets';
import { GetTicketStats } from '../../application/use-cases/GetTicketStats';
import { CreateTicket } from '../../application/use-cases/CreateTicket';
import { GetTicket } from '../../application/use-cases/GetTicket';
import { UpdateTicketStatus } from '../../application/use-cases/UpdateTicketStatus';
import { UpdateTicket } from '../../application/use-cases/UpdateTicket';
import { CloseTicket } from '../../application/use-cases/CloseTicket';
import { createTicketsRouter } from '../../infrastructure/http/routes/tickets.routes';
import type { JwtAuthAdapter } from '../../infrastructure/adapters/jwt/JwtAuthAdapter';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const repo = new InMemoryTicketRepository();
  repo.seedCustomers([
    { id: 'c1', name: 'Alice García' },
    { id: 'c2', name: 'Bob Martínez' },
  ]);

  const listTickets = new ListTickets(repo);
  const getStats = new GetTicketStats(repo);
  const createTicket = new CreateTicket(repo);
  const getTicket = new GetTicket(repo);
  const updateStatus = new UpdateTicketStatus(repo);
  const updateTicket = new UpdateTicket(repo);
  const closeTicket = new CloseTicket(repo);

  const authProvider = {
    getSession: jest.fn().mockResolvedValue({ id: '1', email: 'admin@test.com', role: 'admin' }),
  } as unknown as JwtAuthAdapter;

  app.use(
    '/api/tickets',
    createTicketsRouter(listTickets, getStats, createTicket, getTicket, updateStatus, updateTicket, closeTicket, authProvider),
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

describe('POST /api/tickets', () => {
  it('returns 201 and creates the ticket with customerId', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).post('/api/tickets').send({
        subject: 'Sin señal',
        description: 'No hay Internet',
        customerId: 'c1',
        priority: 'high',
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.customerId).toBe('c1');
    expect(res.body.customerName).toBe('Alice García');
    expect(res.body.status).toBe('open');
    expect(res.body.id).toBeTruthy();
  });

  it('returns 400 when subject is missing', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).post('/api/tickets').send({ description: 'D' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when description is missing', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).post('/api/tickets').send({ subject: 'S' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/tickets', () => {
  it('returns all tickets with total', async () => {
    const { app, repo } = buildApp();
    await new CreateTicket(repo).execute({ subject: 'T1', description: 'D1', customerId: 'c1' });
    await new CreateTicket(repo).execute({ subject: 'T2', description: 'D2', customerId: 'c2' });

    const res = await withAuth(request(app).get('/api/tickets'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);
  });

  it('filters by customerId and returns correct total', async () => {
    const { app, repo } = buildApp();
    await new CreateTicket(repo).execute({ subject: 'T1', description: 'D1', customerId: 'c1' });
    await new CreateTicket(repo).execute({ subject: 'T2', description: 'D2', customerId: 'c1' });
    await new CreateTicket(repo).execute({ subject: 'T3', description: 'D3', customerId: 'c2' });

    const res = await withAuth(request(app).get('/api/tickets?customerId=c1'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data.every((t: { customerId: string }) => t.customerId === 'c1')).toBe(true);
  });

  it('returns empty data with total=0 when customerId has no tickets', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).get('/api/tickets?customerId=c1'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('GET /api/tickets/:id', () => {
  it('returns the ticket when found', async () => {
    const { app, repo } = buildApp();
    const created = await new CreateTicket(repo).execute({ subject: 'Test', description: 'D' });

    const res = await withAuth(request(app).get(`/api/tickets/${created.id}`));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.subject).toBe('Test');
  });

  it('returns 404 when ticket not found', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).get('/api/tickets/non-existent-id'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });
});

describe('PATCH /api/tickets/:id/status', () => {
  it('persists the status change (not an in-memory override)', async () => {
    const { app, repo } = buildApp();
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}/status`).send({ status: 'pending' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');

    // Verify via port directly — not an in-memory override
    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('pending');
  });

  it('returns 400 for invalid status', async () => {
    const { app, repo } = buildApp();
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}/status`).send({ status: 'resolved' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when ticket not found', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/non-existent/status').send({ status: 'pending' }),
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });
});

describe('PATCH /api/tickets/:id (update fields)', () => {
  it('updates subject and persists', async () => {
    const { app, repo } = buildApp();
    const created = await new CreateTicket(repo).execute({ subject: 'Old subject', description: 'D' });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}`).send({ subject: 'New subject' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('New subject');

    const fetched = await repo.getById(created.id);
    expect(fetched?.subject).toBe('New subject');
  });

  it('returns 404 for unknown ticket', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/no-such-id').send({ subject: 'X' }),
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });
});

describe('DELETE /api/tickets/:id (close)', () => {
  it('closes the ticket and returns 200', async () => {
    const { app, repo } = buildApp();
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(request(app).delete(`/api/tickets/${created.id}`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('closed');
  });

  it('returns 404 for unknown ticket', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).delete('/api/tickets/no-such-id'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });
});

describe('GET /api/tickets/stats', () => {
  it('returns stats with real counts', async () => {
    const { app, repo } = buildApp();
    await new CreateTicket(repo).execute({ subject: 'T1', description: 'D' });
    await new CreateTicket(repo).execute({ subject: 'T2', description: 'D' });

    const res = await withAuth(request(app).get('/api/tickets/stats'));
    expect(res.status).toBe(200);
    expect(res.body.totalOpen).toBe(2);
    expect(res.body.byPriority).toBeDefined();
  });
});

describe('GET/POST /api/tickets/:id/replies', () => {
  it('returns empty array for ticket with no replies', async () => {
    const { app, repo } = buildApp();
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(request(app).get(`/api/tickets/${created.id}/replies`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('creates a reply and it appears in GET', async () => {
    const { app, repo } = buildApp();
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    await withAuth(
      request(app)
        .post(`/api/tickets/${created.id}/replies`)
        .send({ message: 'Hola, revisando el caso.', authorId: 1, authorName: 'Admin' }),
    );

    const res = await withAuth(request(app).get(`/api/tickets/${created.id}/replies`));
    expect(res.status).toBe(200);
    const messages = res.body.map((r: { message: string }) => r.message);
    expect(messages).toContain('Hola, revisando el caso.');
  });

  it('returns 400 when reply message is missing', async () => {
    const { app, repo } = buildApp();
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app).post(`/api/tickets/${created.id}/replies`).send({ authorId: 1 }),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('Authentication', () => {
  it('returns 401 without auth cookie on GET /', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/tickets');
    expect(res.status).toBe(401);
  });
});

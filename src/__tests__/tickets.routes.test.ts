/**
 * Legacy tickets route test — updated to use the new createTicketsRouter signature.
 * The canonical integration tests are in infrastructure/tickets.routes.new.test.ts
 * which use the InMemoryTicketRepository directly.
 * This file keeps a minimal smoke-test layer using mocked use cases.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createTicketsRouter } from '../infrastructure/http/routes/tickets.routes';
import { InMemoryTicketStatusRepository } from '../infrastructure/adapters/in-memory/InMemoryTicketStatusRepository';
import type { ListTickets } from '../application/use-cases/ListTickets';
import type { GetTicketStats } from '../application/use-cases/GetTicketStats';
import type { CreateTicket } from '../application/use-cases/CreateTicket';
import type { GetTicket } from '../application/use-cases/GetTicket';
import type { UpdateTicketStatus } from '../application/use-cases/UpdateTicketStatus';
import type { UpdateTicket } from '../application/use-cases/UpdateTicket';
import type { CloseTicket } from '../application/use-cases/CloseTicket';
import type { JwtAuthAdapter } from '../infrastructure/adapters/jwt/JwtAuthAdapter';

const mockTicket = {
  id: '1',
  subject: 'Internet caído',
  description: 'No hay señal.',
  customerId: 'c42',
  customerName: 'Alice García',
  assigneeId: null,
  assigneeName: null,
  grCasoId: null,
  priority: 'high' as const,
  status: 'open' as const,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const mockTickets = [mockTicket];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const listTickets = {
    execute: jest.fn().mockResolvedValue({ data: mockTickets, total: 1, page: 1, limit: 25 }),
  } as unknown as ListTickets;

  const getStats = {
    execute: jest.fn().mockResolvedValue({ totalOpen: 1, totalPending: 0, totalClosed: 0, byPriority: { low: 0, medium: 0, high: 1 } }),
  } as unknown as GetTicketStats;

  const createTicket = {
    execute: jest.fn().mockResolvedValue(mockTicket),
  } as unknown as CreateTicket;

  const getTicket = {
    execute: jest.fn().mockImplementation(async (id: string) =>
      id === '1' ? mockTicket : null,
    ),
  } as unknown as GetTicket;

  const updateStatus = {
    execute: jest.fn().mockImplementation(async (id: string, status: string) =>
      id === '1' ? { ...mockTicket, status } : null,
    ),
  } as unknown as UpdateTicketStatus;

  const updateTicketUc = {
    execute: jest.fn().mockImplementation(async (id: string, data: Record<string, unknown>) =>
      id === '1' ? { ...mockTicket, ...data } : null,
    ),
  } as unknown as UpdateTicket;

  const closeTicket = {
    execute: jest.fn().mockImplementation(async (id: string) =>
      id === '1' ? { ...mockTicket, status: 'closed' } : null,
    ),
  } as unknown as CloseTicket;

  // Real status catalog seeded with the canonical legacy set.
  // create() mutates the in-memory array synchronously (no I/O before the implicit
  // resolve), so seeding without await is safe here.
  const statusRepo = new InMemoryTicketStatusRepository();
  void statusRepo.create({ name: 'open', color: '#22c55e', weight: 0 });
  void statusRepo.create({ name: 'pending', color: '#f59e0b', weight: 1 });
  void statusRepo.create({ name: 'closed', color: '#6b7280', weight: 2 });

  const authProvider = {
    getSession: jest.fn().mockResolvedValue({ id: '1', email: 'admin@test.com', role: 'admin' }),
  } as unknown as JwtAuthAdapter;

  app.use(
    '/api/tickets',
    createTicketsRouter(listTickets, getStats, createTicket, getTicket, updateStatus, updateTicketUc, closeTicket, statusRepo, authProvider),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

function withAuth(req: request.Test) {
  return req.set('Cookie', 'auth_token=mock-token');
}

describe('GET /api/tickets/:id', () => {
  it('returns 200 with the ticket when found', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).get('/api/tickets/1'));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('1');
    expect(res.body.subject).toBe('Internet caído');
  });

  it('returns 404 when ticket not found', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).get('/api/tickets/9999'));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });
});

describe('PATCH /api/tickets/:id/status', () => {
  it('returns 200 with updated status', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/1/status').send({ status: 'pending' }),
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
  });

  it('returns 422 TICKET_STATUS_NOT_FOUND for a status not in the catalog', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/1/status').send({ status: 'resolved' }),
    );

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_STATUS_NOT_FOUND');
  });

  it('returns 400 VALIDATION_ERROR when status is missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/1/status').send({}),
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when ticket not found', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/9999/status').send({ status: 'open' }),
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });
});

describe('GET /api/tickets/:id/replies removed (#44)', () => {
  it('is no longer registered (404)', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).get('/api/tickets/1/replies'));

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/tickets/:id (close)', () => {
  it('returns 200 with closed ticket', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).delete('/api/tickets/1'));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
  });

  it('returns 404 for unknown ticket', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).delete('/api/tickets/9999'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });
});

describe('POST /api/tickets/:id/replies removed (#44)', () => {
  it('is no longer registered (404)', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app)
        .post('/api/tickets/1/replies')
        .send({ message: 'x', authorId: 1, authorName: 'Admin' }),
    );

    expect(res.status).toBe(404);
  });
});

describe('POST /api/tickets', () => {
  it('returns 201 with the created ticket', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/tickets').send({
        subject: 'Nuevo ticket',
        description: 'Descripción',
        customerId: 'c1',
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
  });

  it('returns 400 when subject is missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/tickets').send({ description: 'D' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

describe('Authentication', () => {
  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/tickets');
    expect(res.status).toBe(401);
  });
});

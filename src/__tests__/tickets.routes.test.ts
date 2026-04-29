import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createTicketsRouter } from '../infrastructure/http/routes/tickets.routes';
import type { ListTickets } from '../application/use-cases/ListTickets';
import type { GetTicketStats } from '../application/use-cases/GetTicketStats';
import type { CreateTicket } from '../application/use-cases/CreateTicket';
import type { JwtAuthAdapter } from '../infrastructure/adapters/jwt/JwtAuthAdapter';

const mockTickets = [
  {
    id: '1',
    subject: 'Internet caído',
    clientId: '42',
    clientName: 'Alice García',
    priority: 'alta',
    status: 'abierto',
    description: 'No hay señal.',
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: '2',
    subject: 'Factura errónea',
    clientId: '43',
    clientName: 'Bob Martínez',
    priority: 'media',
    status: 'en_progreso',
    description: 'El monto no coincide.',
    createdAt: '2024-01-02T00:00:00Z',
  },
];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const listTickets = {
    execute: jest.fn().mockResolvedValue({ data: mockTickets, total: 2, page: 1, limit: 25 }),
  } as unknown as ListTickets;

  const getStats = {
    execute: jest.fn().mockResolvedValue({ totalOpen: 2, byPriority: { alta: 1, media: 1, baja: 0 }, assignedToCurrentUser: 0 }),
  } as unknown as GetTicketStats;

  const createTicket = {
    execute: jest.fn().mockResolvedValue(mockTickets[0]),
  } as unknown as CreateTicket;

  // Auth middleware that always allows
  const authProvider = {
    getSession: jest.fn().mockResolvedValue({ id: '1', email: 'admin@test.com', role: 'admin' }),
  } as unknown as JwtAuthAdapter;

  app.use('/api/tickets', createTicketsRouter(listTickets, getStats, createTicket, authProvider));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

// Inject a valid cookie so auth middleware passes
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
      request(app).patch('/api/tickets/1/status').send({ status: 'resolved' })
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved');
  });

  it('returns 400 for invalid status', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/1/status').send({ status: 'unknown' })
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when ticket not found', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/9999/status').send({ status: 'open' })
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });
});

describe('GET /api/tickets/:id/replies', () => {
  it('returns 200 with replies array for ticket 1', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).get('/api/tickets/1/replies'));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('message');
    expect(res.body[0]).toHaveProperty('authorName');
    expect(res.body[0]).toHaveProperty('ticketId', 1);
  });

  it('returns empty array for ticket with no replies', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).get('/api/tickets/9999/replies'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('PATCH /api/tickets/:id/assign', () => {
  it('returns 200 with updated assignment', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/1/assign').send({ assignedTo: 2, assignedToName: 'Soporte' })
    );

    expect(res.status).toBe(200);
    expect(res.body.assignedTo).toBe(2);
    expect(res.body.assignedToName).toBe('Soporte');
  });

  it('assigns null (unassign)', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/1/assign').send({ assignedTo: null, assignedToName: null })
    );

    expect(res.status).toBe(200);
    expect(res.body.assignedTo).toBeNull();
    expect(res.body.assignedToName).toBeNull();
  });

  it('returns 404 when ticket not found', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/9999/assign').send({ assignedTo: 1, assignedToName: 'Admin' })
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });

  it('returns 401 without auth cookie', async () => {
    const app = buildApp();
    const res = await request(app).patch('/api/tickets/1/assign').send({ assignedTo: 1, assignedToName: 'Admin' });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/tickets/:id (edit fields)', () => {
  it('updates subject and returns the ticket with new subject', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/1').send({ subject: 'Nuevo asunto' })
    );

    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('Nuevo asunto');
  });

  it('updates priority and returns the ticket with new priority', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/1').send({ priority: 'baja' })
    );

    expect(res.status).toBe(200);
    expect(res.body.priority).toBe('baja');
  });

  it('returns 404 for unknown ticket id', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).patch('/api/tickets/9999').send({ subject: 'Test' })
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });
});

describe('DELETE /api/tickets/:id', () => {
  it('returns 204 for existing ticket', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).delete('/api/tickets/1'));
    expect(res.status).toBe(204);
  });

  it('returns 404 for unknown ticket id', async () => {
    const app = buildApp();
    const res = await withAuth(request(app).delete('/api/tickets/9999'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_NOT_FOUND');
  });
});

describe('POST /api/tickets/:id/replies', () => {
  it('returns 201 with the created reply', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app)
        .post('/api/tickets/1/replies')
        .send({ message: 'Gracias por su respuesta.', authorId: 1, authorName: 'Admin' })
    );

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Gracias por su respuesta.');
    expect(res.body.authorName).toBe('Admin');
    expect(res.body.ticketId).toBe(1);
    expect(res.body.id).toBeTruthy();
    expect(res.body.createdAt).toBeTruthy();
  });

  it('returns 400 when message is missing', async () => {
    const app = buildApp();
    const res = await withAuth(
      request(app).post('/api/tickets/1/replies').send({ authorId: 1, authorName: 'Admin' })
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET returns reply after POST', async () => {
    const app = buildApp();

    await withAuth(
      request(app)
        .post('/api/tickets/2/replies')
        .send({ message: 'Nueva respuesta de test', authorId: 1, authorName: 'Test User' })
    );

    const res = await withAuth(request(app).get('/api/tickets/2/replies'));
    expect(res.status).toBe(200);
    const messages = res.body.map((r: { message: string }) => r.message);
    expect(messages).toContain('Nueva respuesta de test');
  });
});

/**
 * Integration tests for the new tickets router backed by InMemoryTicketRepository.
 * Tests the canónico contract: GET /api/tickets?customerId=X, POST, PATCH status, DELETE, etc.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketStatusRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketStatusRepository';
import { InMemoryTicketAreaCatalogRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import { ListTickets } from '../../application/use-cases/ListTickets';
import { GetTicketStats } from '../../application/use-cases/GetTicketStats';
import { CreateTicket } from '../../application/use-cases/CreateTicket';
import { GetTicket } from '../../application/use-cases/GetTicket';
import { UpdateTicketStatus } from '../../application/use-cases/UpdateTicketStatus';
import { UpdateTicket } from '../../application/use-cases/UpdateTicket';
import { CloseTicket } from '../../application/use-cases/CloseTicket';
import { createTicketsRouter } from '../../infrastructure/http/routes/tickets.routes';
import type { JwtAuthAdapter } from '../../infrastructure/adapters/jwt/JwtAuthAdapter';
import type { RbacUserRepository } from '../../domain/ports/RbacUserRepository';
import type { RbacUser } from '../../domain/entities/rbac';

// Minimal RbacUserRepository test double: only findById is exercised by the
// tickets router (#48 — reporter existence validation). Seeded with the same
// ids the in-memory ticket repo seeds as admins ('1' Admin Uno, '2' Admin Dos)
// so a body-provided reporterId is validated against a real user pool.
function buildRbacUserRepo(ids: string[]): RbacUserRepository {
  const pool = new Set(ids);
  return {
    findById: async (id: string): Promise<RbacUser | null> =>
      pool.has(id) ? ({ id } as unknown as RbacUser) : null,
  } as unknown as RbacUserRepository;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const repo = new InMemoryTicketRepository();
  repo.seedCustomers([
    { id: 'c1', name: 'Alice García' },
    { id: 'c2', name: 'Bob Martínez' },
  ]);
  // #48 — seed admins so reporterName/assigneeName resolve via JOIN.
  // The auth stub below returns session id '1', so the stamped reporter is '1'.
  repo.seedAdmins([
    { id: '1', name: 'Admin Uno' },
    { id: '2', name: 'Admin Dos' },
  ]);

  // Status catalog — seeded with the legacy canonical set (open/pending/closed).
  const statusRepo = new InMemoryTicketStatusRepository();

  // #49 — area catalog used to validate areaId on create/update
  const areaRepo = new InMemoryTicketAreaCatalogRepository();
  repo.seedAreas(areaRepo);

  const listTickets = new ListTickets(repo);
  const getStats = new GetTicketStats(repo);
  const createTicket = new CreateTicket(repo);
  const getTicket = new GetTicket(repo);
  const updateStatus = new UpdateTicketStatus(repo);
  const updateTicket = new UpdateTicket(repo);
  // M1 (#46): CloseTicket resolves the "closed-like" entry from the catalog
  // (case-insensitive, fallback 'cerrado') instead of writing 'closed' hardcoded.
  const closeTicket = new CloseTicket(repo, statusRepo);

  const authProvider = {
    getSession: jest.fn().mockResolvedValue({ id: '1', email: 'admin@test.com', role: 'admin' }),
  } as unknown as JwtAuthAdapter;

  // #48 — reporter existence is validated against the RbacUser pool. Seed the
  // same ids the ticket repo knows as admins so explicit reporterIds resolve.
  const rbacUserRepo = buildRbacUserRepo(['1', '2']);

  app.use(
    '/api/tickets',
    createTicketsRouter(listTickets, getStats, createTicket, getTicket, updateStatus, updateTicket, closeTicket, statusRepo, authProvider, rbacUserRepo, undefined, undefined, undefined, areaRepo),
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, repo, statusRepo, areaRepo };
}

async function seedCanonicalStatuses(statusRepo: InMemoryTicketStatusRepository) {
  await statusRepo.create({ name: 'open', color: '#22c55e', weight: 0 });
  await statusRepo.create({ name: 'pending', color: '#f59e0b', weight: 1 });
  await statusRepo.create({ name: 'closed', color: '#6b7280', weight: 2 });
}

function withAuth(req: request.Test) {
  return req.set('Cookie', 'auth_token=mock-token');
}

describe('POST /api/tickets', () => {
  it('returns 201 and creates the ticket with customerId', async () => {
    const { app, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    const res = await withAuth(
      request(app).post('/api/tickets').send({
        subject: 'Sin señal',
        description: 'No hay Internet',
        customerId: 'c1',
        priority: 'high',
        areaId: area.id,
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.customerId).toBe('c1');
    expect(res.body.customerName).toBe('Alice García');
    expect(res.body.status).toBe('open');
    expect(res.body.id).toBeTruthy();
    expect(typeof res.body.sequenceNumber).toBe('number'); // #11 — display number
  });

  it('#11: assigns a monotonic sequenceNumber (shown as #N in the list)', async () => {
    const { app, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    const mk = () => withAuth(request(app).post('/api/tickets').send({ subject: 'S', description: 'D', areaId: area.id }));
    const a = await mk();
    const b = await mk();
    expect(b.body.sequenceNumber).toBeGreaterThan(a.body.sequenceNumber);
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

  it('M2: filters by ?status= case-insensitively (protects Archive: closed vs Closed)', async () => {
    const { app, repo, statusRepo, areaRepo } = buildApp();
    await seedCanonicalStatuses(statusRepo);
    const area = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    const created = await new CreateTicket(repo).execute({ subject: 'Closable', description: 'D', areaId: area.id });
    // Close it → ticket.status becomes the canonical catalog name 'closed'.
    await withAuth(request(app).delete(`/api/tickets/${created.id}`));
    // An extra open ticket that must NOT match the closed filter.
    await new CreateTicket(repo).execute({ subject: 'Open', description: 'D', areaId: area.id });

    // Query with a different casing than the stored status.
    const res = await withAuth(request(app).get('/api/tickets?status=Closed'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].id).toBe(created.id);
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
    const { app, repo, statusRepo } = buildApp();
    await seedCanonicalStatuses(statusRepo);
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

  it('accepts a custom catalog status and persists its canonical name (regresión del 400)', async () => {
    const { app, repo, statusRepo } = buildApp();
    await statusRepo.create({ name: 'Resuelto', color: '#3b82f6', weight: 3 });
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}/status`).send({ status: 'Resuelto' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Resuelto');

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('Resuelto');
  });

  it("case-insensitive: 'cerrado' resolves to the canonical 'Cerrado'", async () => {
    const { app, repo, statusRepo } = buildApp();
    await statusRepo.create({ name: 'Cerrado', color: '#6b7280', weight: 5 });
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}/status`).send({ status: 'cerrado' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Cerrado'); // canonical name persisted (AD-3)

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('Cerrado');
  });

  it("legacy catalog in English still works ('closed' seed, no regresión)", async () => {
    const { app, repo, statusRepo } = buildApp();
    await seedCanonicalStatuses(statusRepo);
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}/status`).send({ status: 'closed' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
  });

  it('returns 422 TICKET_STATUS_NOT_FOUND for a status not in the catalog', async () => {
    const { app, repo, statusRepo } = buildApp();
    await seedCanonicalStatuses(statusRepo);
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}/status`).send({ status: 'archivado' }),
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_STATUS_NOT_FOUND');

    // Ticket unchanged
    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('open');
  });

  it('returns 400 VALIDATION_ERROR when status is missing', async () => {
    const { app, repo, statusRepo } = buildApp();
    await seedCanonicalStatuses(statusRepo);
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}/status`).send({}),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when ticket not found', async () => {
    const { app, statusRepo } = buildApp();
    await seedCanonicalStatuses(statusRepo);
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

// #48 — Reporter stamped on create from the authenticated session.
describe('POST /api/tickets — reporter (#48)', () => {
  it('REQ-TICKET-CREATE-1: stamps reporterId from the session when body omits it', async () => {
    const { app, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    const res = await withAuth(
      request(app).post('/api/tickets').send({ subject: 'S', description: 'D', areaId: area.id }),
    );
    expect(res.status).toBe(201);
    // Auth stub returns session id '1'; seedAdmins maps '1' → 'Admin Uno'.
    expect(res.body.reporterId).toBe('1');
    expect(res.body.reporterName).toBe('Admin Uno');
  });

  it('REQ-TICKET-CREATE-2: explicit reporterId in the body wins over the session default', async () => {
    const { app, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    const res = await withAuth(
      request(app).post('/api/tickets').send({ subject: 'S', description: 'D', reporterId: '2', areaId: area.id }),
    );
    expect(res.status).toBe(201);
    expect(res.body.reporterId).toBe('2');
    expect(res.body.reporterName).toBe('Admin Dos');
  });

  it('REQ-TICKET-CREATE-3: a body reporterId that is NOT a known user → 422 REPORTER_NOT_FOUND', async () => {
    const { app, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    // An unknown reporterId would hit a Prisma FK violation (P2003) in prod and
    // surface as a 500. Validate existence up-front and reject with a clear 422.
    const res = await withAuth(
      request(app).post('/api/tickets').send({ subject: 'S', description: 'D', reporterId: 'ghost', areaId: area.id }),
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REPORTER_NOT_FOUND');
  });

  it('REQ-TICKET-CREATE-1b: the session-default path (no body reporterId) is NOT validated and stays 201', async () => {
    const { app, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    // The session user exists by definition; the default stamp must never be
    // re-validated nor blocked. Session id is '1' (Admin Uno).
    const res = await withAuth(
      request(app).post('/api/tickets').send({ subject: 'S', description: 'D', areaId: area.id }),
    );
    expect(res.status).toBe(201);
    expect(res.body.reporterId).toBe('1');
    expect(res.body.reporterName).toBe('Admin Uno');
  });
});

// #48 — Unified save: PATCH /:id accepts status alongside assigneeId/priority.
describe('PATCH /api/tickets/:id — unified save with status (#48)', () => {
  it('REQ-TICKET-UPDATE-1: persists assigneeId + status + priority in a single request', async () => {
    const { app, repo, statusRepo } = buildApp();
    await seedCanonicalStatuses(statusRepo);
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app)
        .patch(`/api/tickets/${created.id}`)
        .send({ assigneeId: '2', status: 'pending', priority: 'high' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.assigneeId).toBe('2');
    expect(res.body.assigneeName).toBe('Admin Dos');
    expect(res.body.priority).toBe('high');

    // Persisted via the port, not an in-memory override.
    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('pending');
    expect(fetched?.assigneeId).toBe('2');
    expect(fetched?.priority).toBe('high');
  });

  it('REQ-TICKET-UPDATE-1: persists the CANONICAL catalog name regardless of casing', async () => {
    const { app, repo, statusRepo } = buildApp();
    await statusRepo.create({ name: 'Cerrado', color: '#6b7280', weight: 5 });
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}`).send({ status: 'cerrado' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Cerrado'); // canonical, not the casing sent
  });

  it('REQ-TICKET-UPDATE-2: unknown status → 422 and NO partial write of the other fields', async () => {
    const { app, repo, statusRepo } = buildApp();
    await seedCanonicalStatuses(statusRepo);
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app)
        .patch(`/api/tickets/${created.id}`)
        .send({ assigneeId: '2', status: 'archivado', priority: 'high' }),
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_STATUS_NOT_FOUND');

    // The ticket must be untouched: no assignee, no priority change, status still open.
    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('open');
    expect(fetched?.assigneeId).toBeNull();
    expect(fetched?.priority).toBe('medium');
  });

  it('REQ-TICKET-UPDATE-3: without status behaves exactly as before (assign-only)', async () => {
    const { app, repo, statusRepo } = buildApp();
    await seedCanonicalStatuses(statusRepo);
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}`).send({ assigneeId: '1' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBe('1');
    expect(res.body.status).toBe('open'); // unchanged
  });
});

describe('DELETE /api/tickets/:id (close)', () => {
  it('closes the ticket and returns 200', async () => {
    const { app, repo, statusRepo } = buildApp();
    await seedCanonicalStatuses(statusRepo);
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(request(app).delete(`/api/tickets/${created.id}`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('closed');
  });

  it('M1: closes using the catalog canonical name when catalog only has "Cerrado" (no \'closed\')', async () => {
    const { app, repo, statusRepo } = buildApp();
    // Catalog renamed/recased: only "Cerrado" exists, no 'closed'.
    await statusRepo.create({ name: 'Cerrado', color: '#6b7280', weight: 2 });
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(request(app).delete(`/api/tickets/${created.id}`));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Cerrado'); // canonical catalog name, not hardcoded 'closed'

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('Cerrado');
  });

  it('M1: returns 422 (not 500) when no closed-like status exists in the catalog', async () => {
    const { app, repo, statusRepo } = buildApp();
    // Catalog has no 'closed'/'cerrado' entry at all.
    await statusRepo.create({ name: 'open', color: '#22c55e', weight: 0 });
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(request(app).delete(`/api/tickets/${created.id}`));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NO_CLOSABLE_STATUS');

    const fetched = await repo.getById(created.id);
    expect(fetched?.status).toBe('open'); // unchanged
  });

  it('returns 404 for unknown ticket', async () => {
    const { app, statusRepo } = buildApp();
    await seedCanonicalStatuses(statusRepo);
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

describe('GET/POST /api/tickets/:id/replies removed (#44)', () => {
  it('GET /:id/replies is no longer registered (404)', async () => {
    const { app, repo } = buildApp();
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(request(app).get(`/api/tickets/${created.id}/replies`));
    expect(res.status).toBe(404);
  });

  it('POST /:id/replies is no longer registered (404)', async () => {
    const { app, repo } = buildApp();
    const created = await new CreateTicket(repo).execute({ subject: 'T', description: 'D' });

    const res = await withAuth(
      request(app)
        .post(`/api/tickets/${created.id}/replies`)
        .send({ message: 'x', authorId: 1, authorName: 'Admin' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('Authentication', () => {
  it('returns 401 without auth cookie on GET /', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/tickets');
    expect(res.status).toBe(401);
  });
});

// #49 — areaId required on create; PATCH accepts optional areaId; list ?areaId= filter
describe('POST /api/tickets — areaId required (#49)', () => {
  it('REQ-TICKET-AREA-1: missing areaId → 422 TICKET_AREA_REQUIRED', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).post('/api/tickets').send({ subject: 'S', description: 'D' }),
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_AREA_REQUIRED');
  });

  it('REQ-TICKET-AREA-2: unknown areaId → 422 TICKET_AREA_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).post('/api/tickets').send({ subject: 'S', description: 'D', areaId: 'non-existent-area' }),
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_AREA_NOT_FOUND');
  });

  it('REQ-TICKET-AREA-3: valid areaId → 201, DTO has areaId + areaName', async () => {
    const { app, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });

    const res = await withAuth(
      request(app).post('/api/tickets').send({ subject: 'S', description: 'D', areaId: area.id }),
    );
    expect(res.status).toBe(201);
    expect(res.body.areaId).toBe(area.id);
    expect(res.body.areaName).toBe('Soporte');
  });
});

describe('PATCH /api/tickets/:id — areaId (#49)', () => {
  it('REQ-TICKET-AREA-4: PATCH with valid areaId updates the area', async () => {
    const { app, repo, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Facturación', color: '#6366f1' });
    const created = await repo.create({ subject: 'T', description: 'D', areaId: area.id });

    const area2 = await areaRepo.create({ name: 'Administración', color: '#6366f1' });
    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}`).send({ areaId: area2.id }),
    );
    expect(res.status).toBe(200);
    expect(res.body.areaId).toBe(area2.id);
    expect(res.body.areaName).toBe('Administración');
  });

  it('REQ-TICKET-AREA-5: PATCH with null areaId clears the area', async () => {
    const { app, repo, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    const created = await repo.create({ subject: 'T', description: 'D', areaId: area.id });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}`).send({ areaId: null }),
    );
    expect(res.status).toBe(200);
    expect(res.body.areaId).toBeNull();
    expect(res.body.areaName).toBeNull();
  });

  it('REQ-TICKET-AREA-6: PATCH with unknown areaId → 422 TICKET_AREA_NOT_FOUND', async () => {
    const { app, repo, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    const created = await repo.create({ subject: 'T', description: 'D', areaId: area.id });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}`).send({ areaId: 'ghost-area' }),
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_AREA_NOT_FOUND');
  });

  it('REQ-TICKET-AREA-7: PATCH without areaId field does not change area', async () => {
    const { app, repo, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    const created = await repo.create({ subject: 'T', description: 'D', areaId: area.id });

    const res = await withAuth(
      request(app).patch(`/api/tickets/${created.id}`).send({ subject: 'Updated' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('Updated');
    expect(res.body.areaId).toBe(area.id);
    expect(res.body.areaName).toBe('Soporte');
  });
});

describe('GET /api/tickets?areaId= — filter by area (#49)', () => {
  it('REQ-TICKET-AREA-8: ?areaId= filters tickets by area', async () => {
    const { app, repo, areaRepo } = buildApp();
    const areaA = await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    const areaB = await areaRepo.create({ name: 'Facturación', color: '#6366f1' });
    await repo.create({ subject: 'T1', description: 'D', areaId: areaA.id });
    await repo.create({ subject: 'T2', description: 'D', areaId: areaA.id });
    await repo.create({ subject: 'T3', description: 'D', areaId: areaB.id });

    const res = await withAuth(request(app).get(`/api/tickets?areaId=${areaA.id}`));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data.every((t: { areaId: string }) => t.areaId === areaA.id)).toBe(true);
  });
});

// #63 — búsqueda LIKE — seam route→use-case→repo
describe('GET /api/tickets?search= — LIKE search seam (#63)', () => {
  it('#63-route-search-customer-name: ?search=<customerName> returns matching ticket through full seam', async () => {
    const { app, repo } = buildApp();
    // c1 = 'Alice García', c2 = 'Bob Martínez' (seeded in buildApp)
    await new CreateTicket(repo).execute({ subject: 'Ticket Alice', description: 'D', customerId: 'c1' });
    await new CreateTicket(repo).execute({ subject: 'Ticket Bob', description: 'D', customerId: 'c2' });

    const res = await withAuth(request(app).get('/api/tickets?search=alice'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].customerName).toBe('Alice García');
  });

  it('#63-route-search-subject: ?search=<subjectTerm> returns matching ticket through full seam', async () => {
    const { app, repo } = buildApp();
    await new CreateTicket(repo).execute({ subject: 'Sin señal en nodo sur', description: 'D' });
    await new CreateTicket(repo).execute({ subject: 'Factura incorrecta', description: 'D' });

    const res = await withAuth(request(app).get('/api/tickets?search=señal'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].subject).toBe('Sin señal en nodo sur');
  });

  it('#63-route-search-sequence: ?search=<N> returns ticket with that sequenceNumber', async () => {
    const { app, repo } = buildApp();
    const t1 = await new CreateTicket(repo).execute({ subject: 'Ticket A', description: 'D' });
    await new CreateTicket(repo).execute({ subject: 'Ticket B', description: 'D' });

    const res = await withAuth(request(app).get(`/api/tickets?search=${t1.sequenceNumber}`));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].sequenceNumber).toBe(t1.sequenceNumber);
  });

  it('#63-fix: ?search=<phone/CUIT> overflowing int4 does not 500 — returns 200 list', async () => {
    // A phone/CUIT pasted into the box overflows PostgreSQL int4. On Prisma this
    // would throw a PrismaClientValidationError → 500; the range guard skips the
    // numeric sequenceNumber clause. The InMemory seam mirrors the same guard.
    const { app, repo } = buildApp();
    // Subject carries the overflowing digit string so the text arm still matches.
    await new CreateTicket(repo).execute({ subject: 'Cliente 11445566778', description: 'D' });
    await new CreateTicket(repo).execute({ subject: 'Otro ticket', description: 'D' });

    const res = await withAuth(request(app).get('/api/tickets?search=11445566778'));
    expect(res.status).toBe(200);
    // Matched by subject (the numeric arm is skipped, never throws).
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].subject).toBe('Cliente 11445566778');
  });
});

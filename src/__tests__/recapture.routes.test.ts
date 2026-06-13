/**
 * Route integration tests for /api/recapture.
 * Uses InMemoryRecaptureRepository — no Prisma.
 * Auth is bypassed with a real mock JwtAuthAdapter.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { createRecaptureRouter } from '../infrastructure/http/routes/recapture.routes';
import { InMemoryRecaptureRepository } from '../infrastructure/adapters/in-memory/InMemoryRecaptureRepository';
import { ListRecaptureLeads } from '../application/use-cases/recapture/ListRecaptureLeads';
import { GetRecaptureLead } from '../application/use-cases/recapture/GetRecaptureLead';
import { ClaimRecaptureLead } from '../application/use-cases/recapture/ClaimRecaptureLead';
import { ClaimNextRecaptureLead } from '../application/use-cases/recapture/ClaimNextRecaptureLead';
import { ReleaseRecaptureLead } from '../application/use-cases/recapture/ReleaseRecaptureLead';
import { UpdateRecaptureLeadStatus } from '../application/use-cases/recapture/UpdateRecaptureLeadStatus';
import { AddRecaptureContact } from '../application/use-cases/recapture/AddRecaptureContact';
import { IngestChurnedClients } from '../application/use-cases/recapture/IngestChurnedClients';
import type { CustomerRepository } from '../domain/ports/CustomerRepository';
import type { JwtAuthAdapter } from '../infrastructure/adapters/jwt/JwtAuthAdapter';

// ─── Auth + RBAC mock helpers ─────────────────────────────────────────────────

/** Always-pass auth middleware: stamps req.user = { id: 'user-test' } */
const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: 'user-test', email: 'test@test.com' };
  next();
};

/** Always-reject RBAC guard (403) */
const denyPerm: RequestHandler = (_req, res, _next) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};

/** Always-pass RBAC guard */
const allowPerm: RequestHandler = (_req, _res, next) => next();

function makeCustomerRepo(clients: Array<{ id: string; name: string; phone: string; email: string }>): CustomerRepository {
  return {
    list: jest.fn().mockResolvedValue({ data: clients, total: clients.length, page: 1, limit: 10000 }),
    findById: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn(),
    listContracts: jest.fn(),
    listInvoices: jest.fn(),
    listLogs: jest.fn(),
  } as unknown as CustomerRepository;
}

// ─── App factory ──────────────────────────────────────────────────────────────

interface BuildAppOptions {
  readPerm?: RequestHandler;
  managePerm?: RequestHandler;
  customerRepo?: CustomerRepository;
  repo?: InMemoryRecaptureRepository;
}

function buildApp(opts: BuildAppOptions = {}) {
  const repo = opts.repo ?? new InMemoryRecaptureRepository();
  const customerRepo = opts.customerRepo ?? makeCustomerRepo([]);

  const listUC = new ListRecaptureLeads(repo);
  const getUC = new GetRecaptureLead(repo);
  const claimUC = new ClaimRecaptureLead(repo);
  const claimNextUC = new ClaimNextRecaptureLead(repo);
  const releaseUC = new ReleaseRecaptureLead(repo);
  const updateStatusUC = new UpdateRecaptureLeadStatus(repo);
  const addContactUC = new AddRecaptureContact(repo);
  const ingestUC = new IngestChurnedClients(repo, customerRepo);

  const authProvider = {
    getSession: jest.fn().mockResolvedValue({ id: 'user-test', email: 'test@test.com', role: 'admin' }),
  } as unknown as JwtAuthAdapter;

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use(
    '/api/recapture',
    createRecaptureRouter(
      listUC, getUC, claimUC, claimNextUC, releaseUC, updateStatusUC, addContactUC, ingestUC,
      allowAuth,
      {
        read: opts.readPerm ?? allowPerm,
        manage: opts.managePerm ?? allowPerm,
      },
    ),
  );

  return { app, repo };
}

// ─── Tests: RBAC gates ────────────────────────────────────────────────────────

describe('GET /api/recapture/leads — RBAC', () => {
  it('returns 403 when read perm denied', async () => {
    const { app } = buildApp({ readPerm: denyPerm });
    const res = await request(app).get('/api/recapture/leads').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(403);
  });

  it('returns 200 with empty list when perm granted', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/recapture/leads').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [], total: 0 });
  });
});

describe('POST /api/recapture/leads/:id/claim — RBAC + 409', () => {
  it('returns 403 when manage perm denied', async () => {
    const { app, repo } = buildApp({ managePerm: denyPerm });
    const lead = await repo.create({ source: 'csv', contactName: 'Test Lead' });
    const res = await request(app)
      .post(`/api/recapture/leads/${lead.id}/claim`)
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(403);
  });

  it('returns 200 and DTO on first claim', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'churned_client', clientId: 'c-1', contactName: 'Alice' });
    const res = await request(app)
      .post(`/api/recapture/leads/${lead.id}/claim`)
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: lead.id,
      assigneeId: 'user-test',
      status: 'en_gestion',
    });
  });

  it('returns 409 on double claim', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Bob' });
    // First claim
    await request(app)
      .post(`/api/recapture/leads/${lead.id}/claim`)
      .set('Cookie', 'auth_token=tok');
    // Second claim
    const res = await request(app)
      .post(`/api/recapture/leads/${lead.id}/claim`)
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RECAPTURE_LEAD_ALREADY_CLAIMED');
  });
});

// ─── Tests: GET /leads ────────────────────────────────────────────────────────

describe('GET /api/recapture/leads', () => {
  it('returns list with correct DTO shape', async () => {
    const { app, repo } = buildApp();
    await repo.create({ source: 'churned_client', clientId: 'c-1', contactName: 'Alice', phone: '123', email: 'a@test.com' });
    const res = await request(app).get('/api/recapture/leads').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const dto = res.body.data[0];
    expect(dto).toHaveProperty('id');
    expect(dto).toHaveProperty('source', 'churned_client');
    expect(dto).toHaveProperty('contactName', 'Alice');
    expect(dto).toHaveProperty('status', 'nuevo');
    expect(dto).toHaveProperty('assigneeId', null);
    expect(dto).toHaveProperty('claimedAt', null);
    expect(dto).toHaveProperty('createdAt');
    expect(dto).toHaveProperty('updatedAt');
  });

  it('passes status filter to use case', async () => {
    const { app, repo } = buildApp();
    const lead1 = await repo.create({ source: 'csv', contactName: 'Lead 1' });
    await repo.create({ source: 'csv', contactName: 'Lead 2' });
    await repo.updateStatus(lead1.id, 'contactado');
    const res = await request(app)
      .get('/api/recapture/leads?status=contactado')
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
});

// ─── Tests: GET /leads/:id ─────────────────────────────────────────────────────

describe('GET /api/recapture/leads/:id', () => {
  it('returns lead detail with contacts', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Carlos' });
    await repo.addContact({ leadId: lead.id, actorId: 'user-test', channel: 'llamada', outcome: 'contactado' });
    const res = await request(app)
      .get(`/api/recapture/leads/${lead.id}`)
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.contactName).toBe('Carlos');
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contacts[0].channel).toBe('llamada');
  });

  it('returns 404 for unknown id', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/recapture/leads/nonexistent')
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RECAPTURE_LEAD_NOT_FOUND');
  });
});

// ─── Tests: POST /leads/claim-next ────────────────────────────────────────────

describe('POST /api/recapture/leads/claim-next', () => {
  it('returns 204 when no free leads exist', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/recapture/leads/claim-next')
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(204);
  });

  it('returns 200 with lead DTO when a free lead is claimed', async () => {
    const { app, repo } = buildApp();
    await repo.create({ source: 'csv', contactName: 'Free Lead' });
    const res = await request(app)
      .post('/api/recapture/leads/claim-next')
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBe('user-test');
  });

  // Seam test: claim-next must skip already-claimed leads and hand back the
  // oldest *free* one. The REAL concurrency guarantee (two operators never get
  // the same lead, and 204 only fires when none are free) lives in the Postgres
  // adapter via `FOR UPDATE SKIP LOCKED` — not testable in-memory (single-threaded).
  it('skips claimed leads and returns the oldest free one (204 only when none free)', async () => {
    const { app, repo } = buildApp();
    const first = await repo.create({ source: 'csv', contactName: 'First' });
    const second = await repo.create({ source: 'csv', contactName: 'Second' });
    // First lead already taken by another operator
    await repo.claim(first.id, 'user-other');

    // claim-next must hand back the second (oldest free), NOT 204
    const res1 = await request(app)
      .post('/api/recapture/leads/claim-next')
      .set('Cookie', 'auth_token=tok');
    expect(res1.status).toBe(200);
    expect(res1.body.id).toBe(second.id);
    expect(res1.body.assigneeId).toBe('user-test');

    // Now everything is claimed → 204
    const res2 = await request(app)
      .post('/api/recapture/leads/claim-next')
      .set('Cookie', 'auth_token=tok');
    expect(res2.status).toBe(204);
  });
});

// ─── Tests: POST /leads/:id/release ──────────────────────────────────────────

describe('POST /api/recapture/leads/:id/release', () => {
  it('releases a claimed lead', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead to Release' });
    await repo.claim(lead.id, 'user-test');
    const res = await request(app)
      .post(`/api/recapture/leads/${lead.id}/release`)
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBeNull();
    expect(res.body.status).toBe('nuevo');
  });
});

// ─── Tests: PATCH /leads/:id ──────────────────────────────────────────────────

describe('PATCH /api/recapture/leads/:id', () => {
  it('updates lead status', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead' });
    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}`)
      .set('Cookie', 'auth_token=tok')
      .send({ status: 'interesado' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('interesado');
  });

  it('returns 400 when status is missing', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead' });
    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}`)
      .set('Cookie', 'auth_token=tok')
      .send({});
    expect(res.status).toBe(400);
  });
});

// ─── Tests: POST /leads/:id/contacts ──────────────────────────────────────────

describe('POST /api/recapture/leads/:id/contacts', () => {
  it('appends a contact and returns DTO', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead' });
    const res = await request(app)
      .post(`/api/recapture/leads/${lead.id}/contacts`)
      .set('Cookie', 'auth_token=tok')
      .send({
        channel: 'whatsapp',
        outcome: 'interesado',
        note: 'Showed interest',
      });
    expect(res.status).toBe(201);
    expect(res.body.channel).toBe('whatsapp');
    expect(res.body.outcome).toBe('interesado');
    expect(res.body.leadId).toBe(lead.id);
  });

  it('returns 400 when channel or outcome is missing', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead' });
    const res = await request(app)
      .post(`/api/recapture/leads/${lead.id}/contacts`)
      .set('Cookie', 'auth_token=tok')
      .send({ channel: 'llamada' }); // missing outcome
    expect(res.status).toBe(400);
  });
});

// ─── Tests: POST /ingest-churned ──────────────────────────────────────────────

describe('POST /api/recapture/ingest-churned', () => {
  it('ingests baja clients and returns count', async () => {
    const { app } = buildApp({
      customerRepo: makeCustomerRepo([
        { id: 'c-1', name: 'Alice', phone: '111', email: 'a@test.com' },
        { id: 'c-2', name: 'Bob', phone: '222', email: 'b@test.com' },
      ]),
    });
    const res = await request(app)
      .post('/api/recapture/ingest-churned')
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.skipped).toBe(0);
  });

  it('is idempotent — returns created=0 on second run', async () => {
    const sharedRepo = new InMemoryRecaptureRepository();
    const customerRepo = makeCustomerRepo([
      { id: 'c-1', name: 'Alice', phone: '111', email: 'a@test.com' },
    ]);
    const { app } = buildApp({ repo: sharedRepo, customerRepo });
    await request(app).post('/api/recapture/ingest-churned').set('Cookie', 'auth_token=tok');
    const res2 = await request(app).post('/api/recapture/ingest-churned').set('Cookie', 'auth_token=tok');
    expect(res2.status).toBe(200);
    expect(res2.body.created).toBe(0);
    expect(res2.body.skipped).toBe(1);
  });
});

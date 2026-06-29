/**
 * Route integration tests for /api/recapture.
 * Uses InMemoryRecaptureRepository â€” no Prisma.
 * Auth is bypassed with a real mock JwtAuthAdapter.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { createRecaptureRouter } from '../infrastructure/http/routes/recapture.routes';
import { InMemoryRecaptureRepository } from '../infrastructure/adapters/in-memory/InMemoryRecaptureRepository';
import { InMemoryContractRepository } from '../infrastructure/adapters/in-memory/InMemoryContractRepository';
import { ListRecaptureLeads } from '../application/use-cases/recapture/ListRecaptureLeads';
import { GetRecaptureLead } from '../application/use-cases/recapture/GetRecaptureLead';
import { UpdateRecaptureLeadStatus } from '../application/use-cases/recapture/UpdateRecaptureLeadStatus';
import { AddRecaptureContact } from '../application/use-cases/recapture/AddRecaptureContact';
import { IngestChurnedClients } from '../application/use-cases/recapture/IngestChurnedClients';
import { ImportCsvLeads } from '../application/use-cases/recapture/ImportCsvLeads';
import { AssignRecaptureLead } from '../application/use-cases/recapture/AssignRecaptureLead';
import { AssignRecaptureLeadsBulk } from '../application/use-cases/recapture/AssignRecaptureLeadsBulk';
import type { CustomerRepository } from '../domain/ports/CustomerRepository';

// â€”â€”â€” Auth + RBAC mock helpers â€”â€”â€”â€”â€”

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

// â€”â€”â€” App factory â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”

interface BuildAppOptions {
  readPerm?: RequestHandler;
  managePerm?: RequestHandler;
  assignPerm?: RequestHandler;
  hasAssignPerm?: (userId: string) => Promise<boolean>;
  customerRepo?: CustomerRepository;
  contractRepo?: InMemoryContractRepository;
  repo?: InMemoryRecaptureRepository;
  auth?: RequestHandler;
}

function buildApp(opts: BuildAppOptions = {}) {
  const repo = opts.repo ?? new InMemoryRecaptureRepository();
  const customerRepo = opts.customerRepo ?? makeCustomerRepo([]);
  const contractRepo = opts.contractRepo ?? new InMemoryContractRepository();
  const hasAssignPerm = opts.hasAssignPerm ?? (async () => true);

  const listUC = new ListRecaptureLeads(repo, contractRepo);
  const getUC = new GetRecaptureLead(repo);
  const updateStatusUC = new UpdateRecaptureLeadStatus(repo);
  const addContactUC = new AddRecaptureContact(repo);
  const ingestUC = new IngestChurnedClients(repo, customerRepo);
  const importCsvUC = new ImportCsvLeads(repo);
  const assignUC = new AssignRecaptureLead(repo, { findById: async (id) => ({ id }) });
  const assignBulkUC = new AssignRecaptureLeadsBulk(repo, { findById: async (id) => ({ id }) });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use(
    '/api/recapture',
    createRecaptureRouter(
      listUC, getUC, updateStatusUC, addContactUC, ingestUC,
      importCsvUC, assignUC, assignBulkUC,
      hasAssignPerm,
      opts.auth ?? allowAuth,
      {
        read: opts.readPerm ?? allowPerm,
        manage: opts.managePerm ?? allowPerm,
        assign: opts.assignPerm ?? allowPerm,
      },
    ),
  );

  return { app, repo, contractRepo };
}

// â€”â€”â€” Tests: RBAC gates â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”

describe('GET /api/recapture/leads â€” RBAC', () => {
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

// â€”â€”â€” Tests: GET /leads ?technology filter (HTTP seam) â€”â€”â€”â€”â€”

describe('GET /api/recapture/leads â€” ?technology filter', () => {
  it('threads the technology query param through to the server-side filter + enriches the response', async () => {
    const { app, repo, contractRepo } = buildApp();
    const wLead = await repo.create({ source: 'churned_client', clientId: 'cli-w', contactName: 'Wireless cli' });
    await repo.create({ source: 'churned_client', clientId: 'cli-f', contactName: 'Fiber cli' });
    // technology NULL (as in prod) → derived from the plan speed by deriveTechnology.
    contractRepo.seed({ clientId: 'cli-w', technology: null, clientName: 'W', plan: '10/5MB' });
    contractRepo.seed({ clientId: 'cli-f', technology: null, clientName: 'F', plan: '300MB' });

    const res = await request(app)
      .get('/api/recapture/leads?technology=Wireless')
      .set('Cookie', 'auth_token=tok');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(wLead.id);
    expect(res.body.data[0].technologies).toEqual(['Wireless']);
  });
});

// â€”â€”â€” Tests: GET /leads (agent scope) â€”â€”â€”â€”â€”

describe('GET /api/recapture/leads â€” agent scope (hasAssignPerm=false)', () => {
  it('agent only sees their own leads (scoped to actorId)', async () => {
    const repo = new InMemoryRecaptureRepository();
    const { app } = buildApp({
      repo,
      hasAssignPerm: async () => false,
    });
    const myLead = await repo.create({ source: 'csv', contactName: 'Mine' });
    await repo.assign(myLead.id, 'user-test');
    await repo.create({ source: 'csv', contactName: 'Others' }); // unassigned

    const res = await request(app).get('/api/recapture/leads').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].id).toBe(myLead.id);
  });

  it('agent ignores ?assigneeId=another query param', async () => {
    const repo = new InMemoryRecaptureRepository();
    const { app } = buildApp({
      repo,
      hasAssignPerm: async () => false,
    });
    const myLead = await repo.create({ source: 'csv', contactName: 'Mine' });
    await repo.assign(myLead.id, 'user-test');
    const otherLead = await repo.create({ source: 'csv', contactName: 'Other' });
    await repo.assign(otherLead.id, 'other-user');

    // Even if they specify ?assigneeId=other-user, they should only get their own
    const res = await request(app)
      .get('/api/recapture/leads?assigneeId=other-user')
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].id).toBe(myLead.id);
  });

  it('admin (hasAssignPerm=true) sees all leads', async () => {
    const repo = new InMemoryRecaptureRepository();
    const { app } = buildApp({
      repo,
      hasAssignPerm: async () => true,
    });
    await repo.create({ source: 'csv', contactName: 'Lead 1' });
    await repo.create({ source: 'csv', contactName: 'Lead 2' });

    const res = await request(app).get('/api/recapture/leads').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('fail-closed: non-admin with no resolvable actorId gets 401 (no listing)', async () => {
    // Defense in depth (SUGGESTION #1): if auth somehow stamps no user id and the
    // actor is not an admin, the assignee filter cannot be applied → deny instead
    // of leaking the full list.
    const repo = new InMemoryRecaptureRepository();
    const noUserAuth: RequestHandler = (req, _res, next) => {
      (req as any).user = {}; // no id
      next();
    };
    const { app } = buildApp({
      repo,
      hasAssignPerm: async () => false,
      auth: noUserAuth,
    });
    await repo.create({ source: 'csv', contactName: 'Lead 1' });
    await repo.create({ source: 'csv', contactName: 'Lead 2' });

    const res = await request(app).get('/api/recapture/leads').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(401);
    expect(res.body.total).toBeUndefined();
  });
});

// â€”â€”â€” Tests: GET /leads/:id (ownership) â€”â€”â€”â€”â€”â€”â€”

describe('GET /api/recapture/leads/:id â€” ownership check', () => {
  it('agent gets 404 for lead belonging to someone else', async () => {
    const repo = new InMemoryRecaptureRepository();
    const { app } = buildApp({
      repo,
      hasAssignPerm: async () => false,
    });
    const lead = await repo.create({ source: 'csv', contactName: 'Other' });
    await repo.assign(lead.id, 'other-user');

    const res = await request(app)
      .get(`/api/recapture/leads/${lead.id}`)
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RECAPTURE_LEAD_NOT_FOUND');
  });

  it('agent gets 200 for own lead', async () => {
    const repo = new InMemoryRecaptureRepository();
    const { app } = buildApp({
      repo,
      hasAssignPerm: async () => false,
    });
    const lead = await repo.create({ source: 'csv', contactName: 'Mine' });
    await repo.assign(lead.id, 'user-test');

    const res = await request(app)
      .get(`/api/recapture/leads/${lead.id}`)
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(lead.id);
  });
});

// â€”â€”â€” Tests: GET /leads â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”

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

// â€”â€”â€” Tests: GET /leads/:id â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”

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

// â€”â€”â€” Tests: PATCH /leads/assign-bulk â€”â€”â€”â€”â€”

describe('PATCH /api/recapture/leads/assign-bulk', () => {
  it('returns 200 with { assigned } on success', async () => {
    const { app, repo } = buildApp();
    const l1 = await repo.create({ source: 'csv', contactName: 'Lead 1' });
    const l2 = await repo.create({ source: 'csv', contactName: 'Lead 2' });

    const res = await request(app)
      .patch('/api/recapture/leads/assign-bulk')
      .set('Cookie', 'auth_token=tok')
      .send({ leadIds: [l1.id, l2.id], operatorId: 'some-op' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assigned: 2 });
  });

  it('returns 400 VALIDATION_ERROR on invalid body (empty leadIds)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/recapture/leads/assign-bulk')
      .set('Cookie', 'auth_token=tok')
      .send({ leadIds: [], operatorId: 'op-1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 VALIDATION_ERROR when leadIds is not an array', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/recapture/leads/assign-bulk')
      .set('Cookie', 'auth_token=tok')
      .send({ leadIds: 'not-an-array', operatorId: 'op-1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 403 without assign perm', async () => {
    const { app, repo } = buildApp({ assignPerm: denyPerm });
    const l1 = await repo.create({ source: 'csv', contactName: 'Lead' });
    const res = await request(app)
      .patch('/api/recapture/leads/assign-bulk')
      .set('Cookie', 'auth_token=tok')
      .send({ leadIds: [l1.id], operatorId: 'op-1' });
    expect(res.status).toBe(403);
  });
});

// â€”â€”â€” Tests: PATCH /leads/:id â€” ownership â€”â€”â€”â€”â€”

describe('PATCH /api/recapture/leads/:id â€” ownership check', () => {
  it('agent gets 404 for lead belonging to someone else', async () => {
    const repo = new InMemoryRecaptureRepository();
    const { app } = buildApp({
      repo,
      hasAssignPerm: async () => false,
    });
    const lead = await repo.create({ source: 'csv', contactName: 'Other' });
    await repo.assign(lead.id, 'other-user');

    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}`)
      .set('Cookie', 'auth_token=tok')
      .send({ status: 'interesado' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RECAPTURE_LEAD_NOT_FOUND');
  });
});

// â€”â€”â€” Tests: POST /leads/:id/contacts â€” ownership â€”â€”â€”â€”â€”

describe('POST /api/recapture/leads/:id/contacts â€” ownership check', () => {
  it('agent gets 404 for lead belonging to someone else', async () => {
    const repo = new InMemoryRecaptureRepository();
    const { app } = buildApp({
      repo,
      hasAssignPerm: async () => false,
    });
    const lead = await repo.create({ source: 'csv', contactName: 'Other' });
    await repo.assign(lead.id, 'other-user');

    const res = await request(app)
      .post(`/api/recapture/leads/${lead.id}/contacts`)
      .set('Cookie', 'auth_token=tok')
      .send({ channel: 'llamada', outcome: 'contactado' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RECAPTURE_LEAD_NOT_FOUND');
  });
});

// â€”â€”â€” Tests: PATCH /leads/:id (status) â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”â€”

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

// Tests: POST /leads/:id/contacts
describe('POST /api/recapture/leads/:id/contacts', () => {
  it('appends a contact and returns DTO', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead' });
    const res = await request(app)
      .post(`/api/recapture/leads/${lead.id}/contacts`)
      .set('Cookie', 'auth_token=tok')
      .send({ channel: 'whatsapp', outcome: 'interesado', note: 'Showed interest' });
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

// Tests: PATCH /leads/:id/assign
describe('PATCH /api/recapture/leads/:id/assign', () => {
  it('returns 403 without assign perm', async () => {
    const { app, repo } = buildApp({ assignPerm: denyPerm });
    const lead = await repo.create({ source: 'csv', contactName: 'Lead' });
    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: 'op-1' });
    expect(res.status).toBe(403);
  });
});

// Tests: POST /ingest-churned
describe('POST /api/recapture/ingest-churned', () => {
  it('ingests baja clients and returns count', async () => {
    const { app } = buildApp({ customerRepo: makeCustomerRepo([{ id: 'c-1', name: 'Alice', phone: '111', email: 'a@test.com' },{ id: 'c-2', name: 'Bob', phone: '222', email: 'b@test.com' }]) });
    const res = await request(app).post('/api/recapture/ingest-churned').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.skipped).toBe(0);
  });
  it('returns 403 without assign perm', async () => {
    const { app } = buildApp({ assignPerm: denyPerm });
    const res = await request(app).post('/api/recapture/ingest-churned').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(403);
  });
  it('is idempotent â€” returns created=0 on second run', async () => {
    const sharedRepo = new InMemoryRecaptureRepository();
    const customerRepo = makeCustomerRepo([{ id: 'c-1', name: 'Alice', phone: '111', email: 'a@test.com' }]);
    const { app } = buildApp({ repo: sharedRepo, customerRepo });
    await request(app).post('/api/recapture/ingest-churned').set('Cookie', 'auth_token=tok');
    const res2 = await request(app).post('/api/recapture/ingest-churned').set('Cookie', 'auth_token=tok');
    expect(res2.status).toBe(200);
    expect(res2.body.created).toBe(0);
    expect(res2.body.skipped).toBe(1);
  });
});

// Tests: POST /import-csv
describe('POST /api/recapture/import-csv', () => {
  it('returns 403 without assign perm (was manage)', async () => {
    const { app } = buildApp({ assignPerm: denyPerm });
    const res = await request(app).post('/api/recapture/import-csv').set('Cookie', 'auth_token=tok').send({ csv: 'nombre,telefono,email,direccion,motivo_baja,plan_anterior\n' });
    expect(res.status).toBe(403);
  });
});

// Tests: removed routes return 404
describe('Removed routes â€” return 404', () => {
  it('POST /leads/claim-next returns 404', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/recapture/leads/claim-next').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(404);
  });
  it('POST /leads/:id/claim returns 404', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead' });
    const res = await request(app).post(`/api/recapture/leads/${lead.id}/claim`).set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(404);
  });
  it('POST /leads/:id/release returns 404', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead' });
    const res = await request(app).post(`/api/recapture/leads/${lead.id}/release`).set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(404);
  });
});

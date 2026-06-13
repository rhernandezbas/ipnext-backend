/**
 * Route integration tests for recapture-refine changes.
 * #3b: assigneeName in GET /leads and GET /leads/:id
 * #4: source filter in GET /leads
 * advanceStatus: POST /leads/:id/contacts accepts a status string, rejects boolean
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
import { ImportCsvLeads } from '../application/use-cases/recapture/ImportCsvLeads';
import { AssignRecaptureLead } from '../application/use-cases/recapture/AssignRecaptureLead';
import type { CustomerRepository } from '../domain/ports/CustomerRepository';
import type { JwtAuthAdapter } from '../infrastructure/adapters/jwt/JwtAuthAdapter';
import type { RecaptureLead } from '../domain/entities/recaptureLead';

// ─── Auth + RBAC mock helpers ─────────────────────────────────────────────────

const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: 'user-test', email: 'test@test.com' };
  next();
};
const allowPerm: RequestHandler = (_req, _res, next) => next();

function makeCustomerRepo(): CustomerRepository {
  return {
    list: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10000 }),
    findById: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn(),
    listContracts: jest.fn(),
    listInvoices: jest.fn(),
    listLogs: jest.fn(),
  } as unknown as CustomerRepository;
}

function buildApp(repo?: InMemoryRecaptureRepository) {
  const r = repo ?? new InMemoryRecaptureRepository();

  const listUC = new ListRecaptureLeads(r);
  const getUC = new GetRecaptureLead(r);
  const claimUC = new ClaimRecaptureLead(r);
  const claimNextUC = new ClaimNextRecaptureLead(r);
  const releaseUC = new ReleaseRecaptureLead(r);
  const updateStatusUC = new UpdateRecaptureLeadStatus(r);
  const addContactUC = new AddRecaptureContact(r);
  const ingestUC = new IngestChurnedClients(r, makeCustomerRepo());
  const importCsvUC = new ImportCsvLeads(r);
  const assignUC = new AssignRecaptureLead(r, { findById: async (id) => ({ id }) });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    '/api/recapture',
    createRecaptureRouter(
      listUC, getUC, claimUC, claimNextUC, releaseUC, updateStatusUC,
      addContactUC, ingestUC, importCsvUC, assignUC,
      allowAuth,
      { read: allowPerm, manage: allowPerm },
    ),
  );

  return { app, repo: r };
}

// ─── #3b: assigneeName in list + detail ──────────────────────────────────────

describe('#3b — assigneeName in route responses', () => {
  it('GET /leads returns assigneeName=null for unassigned lead', async () => {
    const { app, repo } = buildApp();
    await repo.create({ source: 'csv', contactName: 'Unassigned' });
    const res = await request(app).get('/api/recapture/leads').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toHaveProperty('assigneeName', null);
  });

  it('GET /leads returns assigneeName when lead has assignee (pre-seeded)', async () => {
    const { app, repo } = buildApp();
    const lead: RecaptureLead = {
      id: 'route-lead-1',
      source: 'csv',
      clientId: null,
      contactName: 'Con nombre',
      phone: null,
      email: null,
      status: 'en_gestion',
      assigneeId: 'user-55',
      assigneeName: 'Pedro Torres',
      claimedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      address: null,
      churnReason: null,
      previousPlan: null,
    };
    repo.seedLead(lead);
    const res = await request(app).get('/api/recapture/leads').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      assigneeId: 'user-55',
      assigneeName: 'Pedro Torres',
    });
  });

  it('GET /leads/:id returns assigneeName in detail DTO', async () => {
    const { app, repo } = buildApp();
    const lead: RecaptureLead = {
      id: 'route-detail-1',
      source: 'churned_client',
      clientId: 'c-9',
      contactName: 'Detalle',
      phone: null,
      email: null,
      status: 'en_gestion',
      assigneeId: 'user-8',
      assigneeName: 'Ana Gómez',
      claimedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      address: null,
      churnReason: null,
      previousPlan: null,
    };
    repo.seedLead(lead);
    const res = await request(app)
      .get(`/api/recapture/leads/${lead.id}`)
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ assigneeName: 'Ana Gómez' });
  });
});

// ─── #4: source filter via query string ──────────────────────────────────────

describe('#4 — GET /leads?source= route filter', () => {
  async function seedMixed(repo: InMemoryRecaptureRepository) {
    await repo.create({ source: 'churned_client', clientId: 'c-1', contactName: 'Churned A' });
    await repo.create({ source: 'churned_client', clientId: 'c-2', contactName: 'Churned B' });
    await repo.create({ source: 'csv', contactName: 'CSV X' });
  }

  it('?source=csv returns only csv leads', async () => {
    const { app, repo } = buildApp();
    await seedMixed(repo);
    const res = await request(app)
      .get('/api/recapture/leads?source=csv')
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].source).toBe('csv');
  });

  it('?source=churned_client returns only churned_client leads', async () => {
    const { app, repo } = buildApp();
    await seedMixed(repo);
    const res = await request(app)
      .get('/api/recapture/leads?source=churned_client')
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    res.body.data.forEach((d: any) => expect(d.source).toBe('churned_client'));
  });

  it('no source param returns all leads', async () => {
    const { app, repo } = buildApp();
    await seedMixed(repo);
    const res = await request(app)
      .get('/api/recapture/leads')
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
  });

  it('invalid source value is ignored → returns all leads', async () => {
    const { app, repo } = buildApp();
    await seedMixed(repo);
    const res = await request(app)
      .get('/api/recapture/leads?source=foobar')
      .set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    // invalid value ignored → all leads returned
    expect(res.body.total).toBe(3);
  });
});

// ─── advanceStatus: string contract ──────────────────────────────────────────

describe('advanceStatus — route contract', () => {
  it('POST /leads/:id/contacts with advanceStatus=contactado advances lead status', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Advance Test' });
    const res = await request(app)
      .post(`/api/recapture/leads/${lead.id}/contacts`)
      .set('Cookie', 'auth_token=tok')
      .send({
        channel: 'llamada',
        outcome: 'contactado',
        advanceStatus: 'contactado',
      });
    expect(res.status).toBe(201);

    // Verify lead status was advanced
    const detail = await request(app)
      .get(`/api/recapture/leads/${lead.id}`)
      .set('Cookie', 'auth_token=tok');
    expect(detail.body.status).toBe('contactado');
  });

  it('POST /leads/:id/contacts with boolean advanceStatus=true is ignored (not a valid status)', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Boolean Test' });
    // FE (old bug) sends boolean true — route must ignore it (treat as undefined)
    const res = await request(app)
      .post(`/api/recapture/leads/${lead.id}/contacts`)
      .set('Cookie', 'auth_token=tok')
      .send({
        channel: 'llamada',
        outcome: 'contactado',
        advanceStatus: true, // boolean — NOT a valid RecaptureLeadStatus string
      });
    expect(res.status).toBe(201); // contact is still created

    // Status must NOT advance (no valid status was provided)
    const detail = await request(app)
      .get(`/api/recapture/leads/${lead.id}`)
      .set('Cookie', 'auth_token=tok');
    expect(detail.body.status).toBe('nuevo');
  });

  it('POST /leads/:id/contacts with advanceStatus=recuperado advances to recuperado', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'churned_client', contactName: 'Recovery' });
    const res = await request(app)
      .post(`/api/recapture/leads/${lead.id}/contacts`)
      .set('Cookie', 'auth_token=tok')
      .send({
        channel: 'email',
        outcome: 'recuperado',
        advanceStatus: 'recuperado',
      });
    expect(res.status).toBe(201);
    const detail = await request(app)
      .get(`/api/recapture/leads/${lead.id}`)
      .set('Cookie', 'auth_token=tok');
    expect(detail.body.status).toBe('recuperado');
  });
});

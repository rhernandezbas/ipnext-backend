/**
 * Route integration tests for PATCH /api/recapture/leads/:id/assign.
 * Uses InMemoryRecaptureRepository and a stub EntityLookup â€” no Prisma.
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
import type { EntityLookup } from '../domain/ports/EntityLookup';
import type { UserRoleLookup } from '../domain/ports/UserRoleLookup';

// â”€â”€â”€ Auth + RBAC mock helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: 'user-test', email: 'test@test.com' };
  next();
};

const denyPerm: RequestHandler = (_req, res) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
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

// â”€â”€â”€ App factory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface BuildAppOptions {
  readPerm?: RequestHandler;
  managePerm?: RequestHandler;
  assignPerm?: RequestHandler;
  repo?: InMemoryRecaptureRepository;
  knownOperatorIds?: string[];
  /** userId → role codes. Unknown ids default to ['ventas'] (assignable). */
  operatorRoles?: Record<string, string[]>;
}

function buildApp(opts: BuildAppOptions = {}) {
  const repo = opts.repo ?? new InMemoryRecaptureRepository();
  const customerRepo = makeCustomerRepo();
  const contractRepo = new InMemoryContractRepository();

  const knownIds = opts.knownOperatorIds ?? ['op-1', 'op-2', 'user-test'];
  const userLookup: EntityLookup = {
    findById: async (id: string) =>
      knownIds.includes(id) ? { id, name: `Operator ${id}` } : null,
  };

  // Default: every operator carries the 'ventas' role (assignable). Individual
  // ids can be overridden (e.g. a technical or role-less user) via operatorRoles.
  const roleLookup: UserRoleLookup = {
    listRoleCodes: async (id: string) => opts.operatorRoles?.[id] ?? ['ventas'],
  };

  const assignUC = new AssignRecaptureLead(repo, userLookup, roleLookup);
  const assignBulkUC = new AssignRecaptureLeadsBulk(repo, userLookup, roleLookup);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use(
    '/api/recapture',
    createRecaptureRouter(
      new ListRecaptureLeads(repo, contractRepo, customerRepo),
      new GetRecaptureLead(repo, customerRepo, contractRepo),
      new UpdateRecaptureLeadStatus(repo),
      new AddRecaptureContact(repo),
      new IngestChurnedClients(repo, customerRepo, contractRepo),
      new ImportCsvLeads(repo),
      assignUC,
      assignBulkUC,
      async () => true, // default: admin has assign perm
      allowAuth,
      {
        read: opts.readPerm ?? allowPerm,
        manage: opts.managePerm ?? allowPerm,
        assign: opts.assignPerm ?? allowPerm,
      },
    ),
  );

  // Minimal error handler mirroring the real app.ts
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.name === 'ReferenceNotFoundError') {
      res.status(400).json({ error: err.message, code: 'REFERENCE_NOT_FOUND' });
      return;
    }
    const status = err?.statusCode ?? 500;
    res.status(status).json({ error: err?.message ?? 'Internal Server Error', code: err?.code ?? 'INTERNAL_ERROR' });
  });

  return { app, repo };
}

// â”€â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('PATCH /api/recapture/leads/:id/assign â€” RBAC', () => {
  it('returns 403 when assign perm is denied', async () => {
    const { app, repo } = buildApp({ assignPerm: denyPerm });
    const lead = await repo.create({ source: 'csv', contactName: 'Test Lead' });
    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: 'op-1' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/recapture/leads/:id/assign â€” assign to operator', () => {
  it('returns 200 with DTO when assigning a valid operator', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead Alpha' });
    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: 'op-1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: lead.id,
      assigneeId: 'op-1',
      status: 'en_gestion',
    });
    expect(res.body.claimedAt).not.toBeNull();
  });

  it('reassigns a lead that is already claimed by another operator', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead Beta' });
    await repo.claim(lead.id, 'op-1');

    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: 'op-2' });
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBe('op-2');
  });
});

describe('PATCH /api/recapture/leads/:id/assign â€” unassign (operatorId: null)', () => {
  it('returns 200 and clears assignee when operatorId is null', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead Gamma' });
    await repo.claim(lead.id, 'op-1');

    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: null });
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBeNull();
    expect(res.body.claimedAt).toBeNull();
    expect(res.body.status).toBe('nuevo');
  });
});

describe('PATCH /api/recapture/leads/:id/assign â€” validation errors', () => {
  it('returns 400 when body is missing operatorId field entirely', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead Delta' });
    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns error when operatorId is not a real user', async () => {
    const { app, repo } = buildApp({ knownOperatorIds: [] });
    const lead = await repo.create({ source: 'csv', contactName: 'Lead Epsilon' });
    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: 'ghost-user' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when lead does not exist', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/recapture/leads/nonexistent/assign')
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: 'op-1' });
    expect(res.status).toBe(404);
  });
});

// ─── recapture-assignable-roles: assignee-pool enforcement (422) ──────────────

describe('PATCH /api/recapture/leads/:id/assign — assignee pool (recapture-assignable-roles)', () => {
  it('returns 422 RECAPTURE_ASSIGNEE_NOT_ALLOWED when the target holds a technical role', async () => {
    const { app, repo } = buildApp({
      knownOperatorIds: ['tech-user'],
      operatorRoles: { 'tech-user': ['tecnico'] },
    });
    const lead = await repo.create({ source: 'csv', contactName: 'Lead Tech' });

    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: 'tech-user' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RECAPTURE_ASSIGNEE_NOT_ALLOWED');
  });

  it('returns 422 when the target has NO roles at all', async () => {
    const { app, repo } = buildApp({
      knownOperatorIds: ['no-role-user'],
      operatorRoles: { 'no-role-user': [] },
    });
    const lead = await repo.create({ source: 'csv', contactName: 'Lead NoRole' });

    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: 'no-role-user' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RECAPTURE_ASSIGNEE_NOT_ALLOWED');
  });

  it('returns 200 for a noc target (only tecnico is excluded)', async () => {
    const { app, repo } = buildApp({
      knownOperatorIds: ['noc-user'],
      operatorRoles: { 'noc-user': ['noc'] },
    });
    const lead = await repo.create({ source: 'csv', contactName: 'Lead Noc' });

    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: 'noc-user' });

    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBe('noc-user');
  });

  it('returns 200 when unassigning (operatorId null) — pool check is skipped', async () => {
    const { app, repo } = buildApp();
    const lead = await repo.create({ source: 'csv', contactName: 'Lead Unassign' });
    await repo.claim(lead.id, 'op-1');

    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: null });

    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBeNull();
  });

  it('returns 400 REFERENCE_NOT_FOUND (not 422) for a ghost user — existence wins over pool', async () => {
    const { app, repo } = buildApp({ knownOperatorIds: [] });
    const lead = await repo.create({ source: 'csv', contactName: 'Lead Ghost' });

    const res = await request(app)
      .patch(`/api/recapture/leads/${lead.id}/assign`)
      .set('Cookie', 'auth_token=tok')
      .send({ operatorId: 'ghost-user' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('REFERENCE_NOT_FOUND');
  });
});


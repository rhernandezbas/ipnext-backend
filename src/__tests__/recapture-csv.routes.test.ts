/**
 * Route integration tests for the CSV-import endpoints on /api/recapture.
 * Uses InMemoryRecaptureRepository â€” no Prisma.
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

// â”€â”€â”€ Auth + RBAC mock helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: 'user-test', email: 'test@test.com' };
  next();
};

const denyPerm: RequestHandler = (_req, res, _next) => {
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
}

function buildApp(opts: BuildAppOptions = {}) {
  const repo = opts.repo ?? new InMemoryRecaptureRepository();
  const customerRepo = makeCustomerRepo();
  const contractRepo = new InMemoryContractRepository();

  const userLookup: EntityLookup = {
    findById: async (id: string) => ({ id, name: `Operator ${id}` }),
  };

  const assignUC = new AssignRecaptureLead(repo, userLookup);
  const assignBulkUC = new AssignRecaptureLeadsBulk(repo, userLookup);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use(
    '/api/recapture',
    createRecaptureRouter(
      new ListRecaptureLeads(repo, contractRepo),
      new GetRecaptureLead(repo),
      new UpdateRecaptureLeadStatus(repo),
      new AddRecaptureContact(repo),
      new IngestChurnedClients(repo, customerRepo),
      new ImportCsvLeads(repo),
      assignUC,
      assignBulkUC,
      async () => true,
      allowAuth,
      {
        read: opts.readPerm ?? allowPerm,
        manage: opts.managePerm ?? allowPerm,
        assign: opts.assignPerm ?? allowPerm,
      },
    ),
  );

  return { app, repo };
}

// â”€â”€â”€ Tests: POST /import-csv â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('POST /api/recapture/import-csv', () => {
  it('creates leads and returns { created, errors }', async () => {
    const { app } = buildApp();
    const csv = [
      'nombre,telefono,email,direccion,motivo_baja,plan_anterior',
      'Alice,111,a@test.com,Av. 1,precio,basico',
      'Bob,222,b@test.com,Av. 2,velocidad,premium',
    ].join('\n');

    const res = await request(app)
      .post('/api/recapture/import-csv')
      .set('Cookie', 'auth_token=tok')
      .send({ csv });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(2);
    expect(res.body.errors).toHaveLength(0);
  });

  it('returns 403 when assign perm is denied', async () => {
    const { app } = buildApp({ assignPerm: denyPerm });
    const res = await request(app)
      .post('/api/recapture/import-csv')
      .set('Cookie', 'auth_token=tok')
      .send({ csv: 'nombre,telefono,email,direccion,motivo_baja,plan_anterior\n' });

    expect(res.status).toBe(403);
  });

  it('returns 400 when csv field is missing', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/recapture/import-csv')
      .set('Cookie', 'auth_token=tok')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns errors array for invalid rows without aborting', async () => {
    const { app } = buildApp();
    const csv = [
      'nombre,telefono,email,direccion,motivo_baja,plan_anterior',
      ',111,a@test.com,Av. 1,precio,basico',       // missing nombre â€” error
      'Bob,222,b@test.com,Av. 2,velocidad,premium', // valid
    ].join('\n');

    const res = await request(app)
      .post('/api/recapture/import-csv')
      .set('Cookie', 'auth_token=tok')
      .send({ csv });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.errors).toHaveLength(1);
  });
});

// â”€â”€â”€ Tests: GET /import-csv/template â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('GET /api/recapture/import-csv/template', () => {
  it('returns text/csv with correct headers', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/recapture/import-csv/template')
      .set('Cookie', 'auth_token=tok');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('nombre,telefono,email,direccion,motivo_baja,plan_anterior');
  });

  it('returns attachment disposition', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/recapture/import-csv/template')
      .set('Cookie', 'auth_token=tok');

    expect(res.headers['content-disposition']).toMatch(/attachment/);
  });

  it('returns 403 when read perm denied', async () => {
    const { app } = buildApp({ readPerm: denyPerm });
    const res = await request(app)
      .get('/api/recapture/import-csv/template')
      .set('Cookie', 'auth_token=tok');

    expect(res.status).toBe(403);
  });

  it('includes an example data row', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/recapture/import-csv/template')
      .set('Cookie', 'auth_token=tok');

    const lines = res.text.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});


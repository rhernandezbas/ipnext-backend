/**
 * external-create-ticket T2 — POST /api/external/v1/tickets (first WRITE on the
 * external API). Tests the FULL seam: real CreateTicket use case + in-memory
 * repos (NO mocking the use case — CLAUDE.md rule + lección #28 "testear el seam
 * completo"). Covers auth, the curated DTO, and every validation branch
 * (customer/contract FK + ownership → 422, area catalog → 422, priority enum → 400).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { createExternalV1Router } from '../../infrastructure/http/routes/externalV1.routes';
import { createApiKeyMiddleware } from '../../infrastructure/http/middleware/apiKeyMiddleware';
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketAreaCatalogRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import { InMemoryRbacUserRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { CreateTicket } from '../../application/use-cases/CreateTicket';
import { bootstrapApiUser, API_USER_LOGIN } from '../../infrastructure/bootstrap/bootstrapApiUser';
import { ListClients } from '../../application/use-cases/ListClients';
import { GetClientDetail } from '../../application/use-cases/GetClientDetail';

// Mock config so we control the API key without env vars (same pattern as
// externalV1.routes.test.ts).
jest.mock('../../infrastructure/config', () => ({
  config: { externalApi: { apiKey: 'test-external-key' } },
}));

const TEST_KEY = 'test-external-key';

// Read use cases are required by the router signature but NOT exercised by the
// POST /tickets path — bare stubs are fine here.
const stubListClients = { execute: jest.fn() } as unknown as ListClients;
const stubGetClientDetail = { execute: jest.fn() } as unknown as GetClientDetail;

async function buildApp() {
  const repo = new InMemoryTicketRepository();
  repo.seedCustomers([
    { id: 'c1', name: 'Alice García' },
    { id: 'c2', name: 'Bob Martínez' },
  ]);
  // ct1 → c1, ct2 → c2 (ownership: ct2 is c2's, used to trigger the mismatch 422)
  repo.seedContracts([
    { id: 'ct1', clientId: 'c1' },
    { id: 'ct2', clientId: 'c2' },
  ]);

  const areaRepo = new InMemoryTicketAreaCatalogRepository();
  repo.seedAreas(areaRepo); // JOIN-derived areaName resolves in the returned ticket
  await areaRepo.create({ name: 'Soporte', color: '#6366f1' });

  // System "Api" reporter — seeded exactly like production bootstraps it.
  const rbacUserRepo = new InMemoryRbacUserRepository();
  await bootstrapApiUser(rbacUserRepo, { passwordHash: '$2a$10$impossibleHashNeverLogsInXXXXXXXXXXXXXXXXXXXX' });

  // Real use case with the ownership lookups wired (enforces FK + ownership).
  const createTicket = new CreateTicket(repo, repo.customerLookup(), repo.contractLookup());

  const app = express();
  app.use(express.json());
  app.use(
    '/api/external/v1',
    createApiKeyMiddleware(),
    createExternalV1Router(stubListClients, stubGetClientDetail, undefined, {
      createTicket,
      rbacUserRepo,
      ticketAreaRepo: areaRepo,
    }),
  );
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return { app, repo, rbacUserRepo };
}

const validPayload = {
  subject: 'Sin señal',
  description: 'No hay Internet hace 2hs',
  customerId: 'c1',
  contractId: 'ct1',
  area: 'Soporte',
  priority: 'high',
};

describe('POST /api/external/v1/tickets (T2 — first external WRITE)', () => {
  it('returns 401 without an API key', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/external/v1/tickets').send(validPayload);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 201, creates the ticket, and stamps the system "api" user as reporter', async () => {
    const { app, repo, rbacUserRepo } = await buildApp();
    const apiUser = await rbacUserRepo.findByLogin(API_USER_LOGIN);

    const res = await request(app)
      .post('/api/external/v1/tickets')
      .set('X-API-Key', TEST_KEY)
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.subject).toBe('Sin señal');
    expect(res.body.description).toBe('No hay Internet hace 2hs');
    expect(res.body.priority).toBe('high');
    expect(res.body.customerId).toBe('c1');
    expect(res.body.contractId).toBe('ct1');
    expect(res.body.areaName).toBe('Soporte');

    // The reporter is the system api user — stamped INTERNALLY, never exposed.
    const created = await repo.getById(res.body.id);
    expect(created).not.toBeNull();
    expect(created!.reporterId).toBe(apiUser!.id);
  });

  it('curated DTO — does NOT leak internal fields', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/tickets')
      .set('X-API-Key', TEST_KEY)
      .send(validPayload);

    expect(res.status).toBe(201);
    // Internal / PII fields MUST be absent.
    expect(res.body).not.toHaveProperty('reporterId');
    expect(res.body).not.toHaveProperty('reporterName');
    expect(res.body).not.toHaveProperty('areaId');
    expect(res.body).not.toHaveProperty('areaColor');
    expect(res.body).not.toHaveProperty('assigneeId');
    expect(res.body).not.toHaveProperty('assigneeName');
    expect(res.body).not.toHaveProperty('customerName');
    expect(res.body).not.toHaveProperty('grCasoId');
    // Safe fields present.
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('sequenceNumber');
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('createdAt');
  });

  it('returns 422 when the customer does not exist', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/tickets')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, customerId: 'ghost' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it('returns 422 when the contract does not exist', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/tickets')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, contractId: 'ghost' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('returns 422 when the contract belongs to another customer (ownership)', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/tickets')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, customerId: 'c1', contractId: 'ct2' }); // ct2 → c2
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CONTRACT_CUSTOMER_MISMATCH');
  });

  it('returns 422 when the area is not in the catalog', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/tickets')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, area: 'Área Inexistente' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TICKET_AREA_NOT_FOUND');
  });

  it('returns 400 when the priority is not one of low|medium|high', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/tickets')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, priority: 'urgent' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when a required field is missing', async () => {
    const { app } = await buildApp();
    const { subject, ...noSubject } = validPayload;
    void subject;
    const res = await request(app)
      .post('/api/external/v1/tickets')
      .set('X-API-Key', TEST_KEY)
      .send(noSubject);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // fix-wave (review MEDIUM — abuso de almacenamiento): subject/description sin
  // techo de longitud dejan a un key holder inyectar ~100kb de texto por request.
  it('returns 400 when subject exceeds the max length', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/tickets')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, subject: 'x'.repeat(201) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when description exceeds the max length', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/external/v1/tickets')
      .set('X-API-Key', TEST_KEY)
      .send({ ...validPayload, description: 'x'.repeat(5001) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // fix-wave (review BAJA — gap de cobertura): la guarda defensiva 503 (usuario
  // "api" no provisionado) no estaba ejercitada. Monta el router SIN sembrar el api user.
  it('returns 503 when the system "api" reporter is not provisioned', async () => {
    const repo = new InMemoryTicketRepository();
    repo.seedCustomers([{ id: 'c1', name: 'Alice García' }]);
    repo.seedContracts([{ id: 'ct1', clientId: 'c1' }]);
    const areaRepo = new InMemoryTicketAreaCatalogRepository();
    repo.seedAreas(areaRepo);
    await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    const rbacUserRepo = new InMemoryRbacUserRepository(); // NO api user seeded
    const createTicket = new CreateTicket(repo, repo.customerLookup(), repo.contractLookup());

    const app = express();
    app.use(express.json());
    app.use(
      '/api/external/v1',
      createApiKeyMiddleware(),
      createExternalV1Router(stubListClients, stubGetClientDetail, undefined, {
        createTicket,
        rbacUserRepo,
        ticketAreaRepo: areaRepo,
      }),
    );
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      res.status(500).json({ error: 'Internal server error' });
    });

    const res = await request(app)
      .post('/api/external/v1/tickets')
      .set('X-API-Key', TEST_KEY)
      .send(validPayload);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('REPORTER_UNAVAILABLE');
  });
});

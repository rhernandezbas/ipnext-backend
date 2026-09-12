/**
 * suricata-tickets-mirror (Phase D, tasks D.4/D.6, spec suricata-bot-verdict
 * VERDICT-1..5, rbac-permission-catalog-extension RBAC-EXT-3, design D7.c) —
 * supertest over `composeSuricataExternalModule` with REAL use cases +
 * InMemory adapters (repo convention: never mock Prisma, never mock the use
 * case — a mocked use case hides passthrough bugs).
 */
import request from 'supertest';
import express from 'express';
import { composeSuricataExternalModule } from '@infrastructure/http/composeSuricataExternalModule';
import { createApiKeyMiddleware } from '@infrastructure/http/middleware/apiKeyMiddleware';
import { machineActorMiddleware } from '@infrastructure/http/middleware/machineActorMiddleware';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';
import { bootstrapApiSuricataUser } from '@infrastructure/bootstrap/bootstrapApiSuricataUser';
import { SubmitSuricataVerdict } from '@application/use-cases/suricata/SubmitSuricataVerdict';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataVerdictRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataVerdictRepository';
import { InMemorySuricataAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAttachmentRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';

// `apiKeyMiddleware.ts` imports `config`, which fail-fasts at import time if
// REQUIRED_VARS aren't set (molde `external-messaging.routes.test.ts`). This
// router test passes keys EXPLICITLY to `createApiKeyMiddleware`, so the
// mocked value here only exists to dodge the env crash.
jest.mock('@infrastructure/config', () => ({
  config: {
    externalApi: { apiKey: 'unused-global-key' },
    suricata: { externalApiKey: 'unused-mock-value' },
  },
}));

const FLAG_KEY = 'suricata-verdict-enabled';
const DEDICATED_KEY = 'dedicated-suricata-key';
const GLOBAL_KEY = 'some-other-global-key';

interface BuildAppOpts {
  flagEnabled?: boolean;
}

function buildApp(opts: BuildAppOpts = {}) {
  const tickets = new InMemorySuricataTicketRepository();
  const verdicts = new InMemorySuricataVerdictRepository();
  const attachments = new InMemorySuricataAttachmentRepository();
  const fileStorage = new InMemoryFileStorage();
  const featureFlags = new InMemoryFeatureFlagRepository();
  if (opts.flagEnabled !== false) featureFlags.seed(FLAG_KEY, true);
  const rbacUserRepo = new InMemoryRbacUserRepository();

  const submitSuricataVerdict = new SubmitSuricataVerdict(tickets, verdicts);

  const router = composeSuricataExternalModule({
    submitSuricataVerdict,
    ticketRepo: tickets,
    attachmentRepo: attachments,
    fileStorage,
    featureFlags,
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/external/v1/suricata',
    createApiKeyMiddleware(DEDICATED_KEY),
    machineActorMiddleware(rbacUserRepo, API_SURICATA_USER_LOGIN),
    router,
  );
  app.use(errorHandler);

  return { app, tickets, verdicts, attachments, fileStorage, featureFlags, rbacUserRepo };
}

async function seedTicket(tickets: InMemorySuricataTicketRepository, externalId = 'ext-1') {
  return tickets.upsertByExternalId({
    externalId,
    subject: 'No tengo internet',
    status: 'abierto',
    priority: 'alta',
    areaId: null,
    customerName: 'Juan Perez',
    customerEmail: 'juan@example.com',
    customerPhone: null,
    externalClientRef: null,
    clientId: null,
    openedAt: '2026-09-01T09:00:00.000Z',
    lastMessageAt: '2026-09-01T09:00:00.000Z',
    contentHash: 'hash-v1',
    syncedAt: '2026-09-01T09:00:00.000Z',
  });
}

const VALID_BODY = { resuelto: true, analisis: 'todo resuelto' };

describe('POST /api/external/v1/suricata/tickets/:externalId/verdict', () => {
  it('VERDICT-1 — missing token -> 401 before any logic (no verdict row, no ticket needed)', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/external/v1/suricata/tickets/ext-1/verdict').send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('VERDICT-1 — dedicated key passes auth (200/201 path reached)', async () => {
    const { app, tickets } = buildApp();
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/verdict')
      .set('X-API-Key', DEDICATED_KEY)
      .send(VALID_BODY);
    expect(res.status).toBe(201);
  });

  it('RBAC-EXT-3 — the GLOBAL external-v1 key (dedicated != global) is rejected with 401', async () => {
    const { app, tickets } = buildApp();
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/verdict')
      .set('X-API-Key', GLOBAL_KEY)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('RBAC-EXT-3 — an RBAC session header alone (no token) is rejected with 401', async () => {
    const { app, tickets } = buildApp();
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/verdict')
      .set('Cookie', 'session=some-valid-looking-session-cookie')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('flag OFF -> 403, before touching the ticket repo', async () => {
    const { app, tickets } = buildApp({ flagEnabled: false });
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/verdict')
      .set('X-API-Key', DEDICATED_KEY)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });

  it('malformed body (wrong types) -> 400, never 500', async () => {
    const { app, tickets } = buildApp();
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/verdict')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ resuelto: 'not-a-boolean', analisis: 123 });
    expect(res.status).toBe(400);
  });

  it('VERDICT-2 — resuelto=false without motivo/respuestaSugerida -> 400 with missingFields', async () => {
    const { app, tickets } = buildApp();
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/verdict')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ resuelto: false, analisis: 'no se pudo resolver' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SURICATA_VERDICT_INVALID');
    expect(res.body.missingFields).toEqual(['motivo', 'respuestaSugerida']);
  });

  it('VERDICT-3 — unknown ticket externalId -> 404, no verdict persisted', async () => {
    const { app, verdicts } = buildApp();
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ghost/verdict')
      .set('X-API-Key', DEDICATED_KEY)
      .send(VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SURICATA_TICKET_NOT_FOUND');
    expect(await verdicts.listByTicket('ghost')).toHaveLength(0);
  });

  it('VERDICT-4 — a second submission on the same ticket persists a SECOND row', async () => {
    const { app, tickets, verdicts } = buildApp();
    const ticket = await seedTicket(tickets);
    await request(app).post('/api/external/v1/suricata/tickets/ext-1/verdict').set('X-API-Key', DEDICATED_KEY).send(VALID_BODY);
    await request(app).post('/api/external/v1/suricata/tickets/ext-1/verdict').set('X-API-Key', DEDICATED_KEY).send(VALID_BODY);

    expect(await verdicts.listByTicket(ticket.id)).toHaveLength(2);
  });
});

describe('GET /api/external/v1/suricata/tickets/:externalId/attachments/:id/content (D7.c)', () => {
  it('missing token -> 401', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/external/v1/suricata/tickets/ext-1/attachments/any/content');
    expect(res.status).toBe(401);
  });

  it('flag OFF -> 403', async () => {
    const { app } = buildApp({ flagEnabled: false });
    const res = await request(app)
      .get('/api/external/v1/suricata/tickets/ext-1/attachments/any/content')
      .set('X-API-Key', DEDICATED_KEY);
    expect(res.status).toBe(403);
  });

  it('unknown ticket -> 404', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/external/v1/suricata/tickets/ghost/attachments/any/content')
      .set('X-API-Key', DEDICATED_KEY);
    expect(res.status).toBe(404);
  });

  it('attachment id belonging to ANOTHER ticket -> 404, never 200', async () => {
    const { app, tickets, attachments, fileStorage } = buildApp();
    await seedTicket(tickets, 'ext-1');
    const otherTicket = await seedTicket(tickets, 'ext-2');
    const attachment = await attachments.upsertByExternalRef({
      ticketId: otherTicket.id,
      messageId: null,
      externalRef: 'ref-1',
      fileName: 'foto.jpg',
      mimeType: 'image/jpeg',
    });
    await attachments.markStored(attachment.id, { sha256: 'abc123', storageKey: 'suricata/abc123', sizeBytes: 10 });
    await fileStorage.save({ key: 'suricata/abc123', buffer: Buffer.from('binary-data'), mimeType: 'image/jpeg' });

    const res = await request(app)
      .get(`/api/external/v1/suricata/tickets/ext-1/attachments/${attachment.id}/content`)
      .set('X-API-Key', DEDICATED_KEY);

    expect(res.status).toBe(404);
  });

  it('valid attachment for the SAME ticket -> 200, streams the binary via FileStorage.get, no signed URL in the body', async () => {
    const { app, tickets, attachments, fileStorage } = buildApp();
    const ticket = await seedTicket(tickets, 'ext-1');
    const attachment = await attachments.upsertByExternalRef({
      ticketId: ticket.id,
      messageId: null,
      externalRef: 'ref-1',
      fileName: 'foto.jpg',
      mimeType: 'image/jpeg',
    });
    await attachments.markStored(attachment.id, { sha256: 'abc123', storageKey: 'suricata/abc123', sizeBytes: 11 });
    await fileStorage.save({ key: 'suricata/abc123', buffer: Buffer.from('binary-data'), mimeType: 'image/jpeg' });

    const res = await request(app)
      .get(`/api/external/v1/suricata/tickets/ext-1/attachments/${attachment.id}/content`)
      .set('X-API-Key', DEDICATED_KEY);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.body).toEqual(Buffer.from('binary-data'));
  });
});

describe('machine actor audit wiring', () => {
  it('req.user resolves to the bootstrapped api-suricata user (for auditMutationsMiddleware)', async () => {
    const { app, tickets, rbacUserRepo } = buildApp();
    await seedTicket(tickets);
    await bootstrapApiSuricataUser(rbacUserRepo, { passwordHash: 'unusable-hash' });

    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/verdict')
      .set('X-API-Key', DEDICATED_KEY)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    const user = await rbacUserRepo.findByLogin(API_SURICATA_USER_LOGIN);
    expect(user).not.toBeNull();
  });
});

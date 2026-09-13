/**
 * suricata-bot-autonomous-actions (Phase F, task F.3, spec suricata-ticket-close
 * CLOSE-1..7, design D4/D7) — supertest over `composeSuricataExternalModule`
 * with REAL use cases + InMemory adapters (repo convention: never mock
 * Prisma, never mock the use case), molde
 * `externalV1.suricata.note.routes.test.ts`'s flag/key/validation shape.
 */
import request from 'supertest';
import express from 'express';
import { composeSuricataExternalModule } from '@infrastructure/http/composeSuricataExternalModule';
import { createApiKeyMiddleware } from '@infrastructure/http/middleware/apiKeyMiddleware';
import { machineActorMiddleware } from '@infrastructure/http/middleware/machineActorMiddleware';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';
import { SubmitSuricataVerdict } from '@application/use-cases/suricata/SubmitSuricataVerdict';
import { ListSuricataTickets } from '@application/use-cases/suricata/ListSuricataTickets';
import { GetSuricataTicketDetail } from '@application/use-cases/suricata/GetSuricataTicketDetail';
import { ComputeSuricataKpis } from '@application/use-cases/suricata/ComputeSuricataKpis';
import { AddSuricataInternalNote } from '@application/use-cases/suricata/AddSuricataInternalNote';
import { ChangeSuricataTicketStatus } from '@application/use-cases/suricata/ChangeSuricataTicketStatus';
import { CloseSuricataTicket } from '@application/use-cases/suricata/CloseSuricataTicket';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataVerdictRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataVerdictRepository';
import { InMemorySuricataAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAttachmentRepository';
import { InMemorySuricataMessageRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataMessageRepository';
import { InMemorySuricataAreaRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAreaRepository';
import { InMemorySuricataBotActionAuditRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataBotActionAuditRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import type { SuricataTicketClosePort } from '@domain/ports/SuricataTicketClosePort';

jest.mock('@infrastructure/config', () => ({
  config: {
    externalApi: { apiKey: 'unused-global-key' },
    suricata: { externalApiKey: 'unused-mock-value' },
  },
}));

const VERDICT_FLAG_KEY = 'suricata-verdict-enabled';
const CLOSE_FLAG_KEY = 'suricata-bot-close-enabled';
const DEDICATED_KEY = 'dedicated-suricata-key';
const GLOBAL_KEY = 'some-other-global-key';

type SpySuricataTicketClosePort = SuricataTicketClosePort & { calls: Array<[string, string]> };

function spyClosePort(impl: (externalId: string, reason: string) => Promise<void>): SpySuricataTicketClosePort {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    close: async (externalId: string, reason: string) => {
      calls.push([externalId, reason]);
      return impl(externalId, reason);
    },
  };
}

interface BuildAppOpts {
  closeFlagEnabled?: boolean;
  closePort?: SpySuricataTicketClosePort;
}

function buildApp(opts: BuildAppOpts = {}) {
  const tickets = new InMemorySuricataTicketRepository();
  const verdicts = new InMemorySuricataVerdictRepository();
  const attachments = new InMemorySuricataAttachmentRepository();
  const messages = new InMemorySuricataMessageRepository();
  const areaRepo = new InMemorySuricataAreaRepository();
  const audits = new InMemorySuricataBotActionAuditRepository();
  const fileStorage = new InMemoryFileStorage();
  const featureFlags = new InMemoryFeatureFlagRepository();
  featureFlags.seed(VERDICT_FLAG_KEY, true);
  featureFlags.seed(CLOSE_FLAG_KEY, opts.closeFlagEnabled !== false);
  const rbacUserRepo = new InMemoryRbacUserRepository();
  const closePort = opts.closePort ?? spyClosePort(async () => {});
  // This suite doesn't exercise the note/status routes — no-op fake ports are enough.
  const notePort = { addNote: async () => {} };
  const statusPort = { changeStatus: async () => {} };

  const submitSuricataVerdict = new SubmitSuricataVerdict(tickets, verdicts);
  const listSuricataTickets = new ListSuricataTickets(tickets, verdicts, areaRepo, rbacUserRepo);
  const getSuricataTicketDetail = new GetSuricataTicketDetail(tickets, messages, attachments, verdicts, areaRepo, rbacUserRepo);
  const computeSuricataKpis = new ComputeSuricataKpis(tickets, verdicts);
  const addSuricataInternalNote = new AddSuricataInternalNote(tickets, audits, notePort);
  const changeSuricataTicketStatus = new ChangeSuricataTicketStatus(tickets, audits, statusPort);
  const closeSuricataTicket = new CloseSuricataTicket(tickets, audits, closePort);

  const router = composeSuricataExternalModule({
    submitSuricataVerdict,
    ticketRepo: tickets,
    attachmentRepo: attachments,
    fileStorage,
    featureFlags,
    listSuricataTickets,
    getSuricataTicketDetail,
    computeSuricataKpis,
    addSuricataInternalNote,
    changeSuricataTicketStatus,
    closeSuricataTicket,
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

  return { app, tickets, audits, featureFlags, closePort };
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

describe('POST /api/external/v1/suricata/tickets/:externalId/close', () => {
  it('CLOSE-1 — missing token -> 401, before any driver call', async () => {
    const { app, closePort } = buildApp();
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/close')
      .send({ reason: 'Reclamo resuelto' });
    expect(res.status).toBe(401);
    expect(closePort.calls).toHaveLength(0);
  });

  it('CLOSE-1 — the GLOBAL external-v1 key (dedicated != global) is rejected with 401', async () => {
    const { app, tickets } = buildApp();
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/close')
      .set('X-API-Key', GLOBAL_KEY)
      .send({ reason: 'Reclamo resuelto' });
    expect(res.status).toBe(401);
  });

  it('CLOSE-1 — flag OFF -> 403 FEATURE_DISABLED, before any driver call, independent of the verdict flag (which stays ON)', async () => {
    const { app, tickets, closePort } = buildApp({ closeFlagEnabled: false });
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/close')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ reason: 'Reclamo resuelto' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(closePort.calls).toHaveLength(0);
  });

  it('CLOSE-2 — empty reason -> 400, before any driver call and no audit row', async () => {
    const { app, tickets, audits, closePort } = buildApp();
    const ticket = await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/close')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ reason: '' });
    expect(res.status).toBe(400);
    expect(closePort.calls).toHaveLength(0);
    expect(await audits.listByTicket(ticket.id)).toHaveLength(0);
  });

  it('CLOSE-2 — missing reason field -> 400, never 500', async () => {
    const { app, tickets } = buildApp();
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/close')
      .set('X-API-Key', DEDICATED_KEY)
      .send({});
    expect(res.status).toBe(400);
  });

  it('CLOSE-3 — unknown ticket externalId -> 404, no audit row', async () => {
    const { app, audits } = buildApp();
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ghost/close')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ reason: 'Reclamo resuelto' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SURICATA_TICKET_NOT_FOUND');
    expect(await audits.listByTicket('ghost')).toHaveLength(0);
  });

  it('success -> 201 with auditId, driver invoked with the exact reason, no mirror status assertion (close writes nothing locally, F.2)', async () => {
    const { app, tickets, closePort } = buildApp();
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/close')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ reason: 'Reclamo resuelto' });
    expect(res.status).toBe(201);
    expect(res.body.auditId).toEqual(expect.any(String));
    expect(closePort.calls).toEqual([['ext-1', 'Reclamo resuelto']]);
    const after = await tickets.findByExternalId('ext-1');
    expect(after?.status).toBe('abierto');
  });

  it('driver failure -> 502 with auditId, audit row stays failed', async () => {
    const failingPort = spyClosePort(async () => {
      throw new Error('DOM changed, could not find the close modal');
    });
    const { app, tickets, audits } = buildApp({ closePort: failingPort });
    const ticket = await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/close')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ reason: 'Reclamo resuelto' });
    expect(res.status).toBe(502);
    expect(res.body.auditId).toEqual(expect.any(String));
    const rows = await audits.listByTicket(ticket.id);
    expect(rows.some((r) => r.outcome === 'failed')).toBe(true);
  });

  it('independence — close flag OFF while verdict flag stays ON does not block the pre-existing verdict route', async () => {
    const { app, tickets } = buildApp({ closeFlagEnabled: false });
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/verdict')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ resuelto: true, analisis: 'todo resuelto' });
    expect(res.status).toBe(201);
  });
});

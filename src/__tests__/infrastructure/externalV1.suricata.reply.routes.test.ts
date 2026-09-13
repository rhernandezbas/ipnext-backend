/**
 * suricata-bot-autonomous-actions (Phase G, task G.5, spec EXTREPLY-1..5,
 * design D3.b/D4.a/D7 CORRECTED 2026-09-13) — supertest over
 * `composeSuricataExternalModule` with REAL use cases + InMemory adapters
 * (repo convention: never mock Prisma, never mock the use case), molde
 * `externalV1.suricata.close.routes.test.ts`'s flag/key/validation shape.
 * Never a real network call -- the port is a fake/spy `BotpressReplyPort`.
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
import { SendAutonomousSuricataReply } from '@application/use-cases/suricata/SendAutonomousSuricataReply';
import { InMemorySuricataTicketRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataTicketRepository';
import { InMemorySuricataVerdictRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataVerdictRepository';
import { InMemorySuricataAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAttachmentRepository';
import { InMemorySuricataMessageRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataMessageRepository';
import { InMemorySuricataAreaRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataAreaRepository';
import { InMemorySuricataBotActionAuditRepository } from '@infrastructure/adapters/in-memory/InMemorySuricataBotActionAuditRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import type { BotpressReplyPort } from '@domain/ports/BotpressReplyPort';

jest.mock('@infrastructure/config', () => ({
  config: {
    externalApi: { apiKey: 'unused-global-key' },
    suricata: { externalApiKey: 'unused-mock-value' },
  },
}));

const VERDICT_FLAG_KEY = 'suricata-verdict-enabled';
const REPLY_FLAG_KEY = 'suricata-bot-reply-enabled';
// EXTREPLY-2 — the INTERNAL panel's own reply flag. Seeding/toggling it here
// must have ZERO effect on this external route (independence test below).
const INTERNAL_REPLY_FLAG_KEY = 'suricata-reply-enabled';
const DEDICATED_KEY = 'dedicated-suricata-key';
const GLOBAL_KEY = 'some-other-global-key';

type SpyBotpressReplyPort = BotpressReplyPort & {
  getConversationIdCalls: string[];
  sendReplyCalls: Array<[string, string]>;
};

function spyReplyPort(opts: {
  conversationId?: string | null;
  send?: (conversationId: string, body: string) => Promise<{ whatsappId?: string }>;
} = {}): SpyBotpressReplyPort {
  const getConversationIdCalls: string[] = [];
  const sendReplyCalls: Array<[string, string]> = [];
  const conversationId = opts.conversationId === undefined ? 'conv_1' : opts.conversationId;
  const send = opts.send ?? (async () => ({ whatsappId: 'wamid.default' }));
  return {
    getConversationIdCalls,
    sendReplyCalls,
    getConversationId: async (ticketExternalId: string) => {
      getConversationIdCalls.push(ticketExternalId);
      return conversationId;
    },
    sendReply: async (convId: string, body: string) => {
      sendReplyCalls.push([convId, body]);
      return send(convId, body);
    },
  };
}

interface BuildAppOpts {
  replyFlagEnabled?: boolean;
  internalReplyFlagEnabled?: boolean;
  replyPort?: SpyBotpressReplyPort;
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
  featureFlags.seed(REPLY_FLAG_KEY, opts.replyFlagEnabled !== false);
  // EXTREPLY-2 — seeded independently; this route never reads this key.
  featureFlags.seed(INTERNAL_REPLY_FLAG_KEY, opts.internalReplyFlagEnabled ?? false);
  const rbacUserRepo = new InMemoryRbacUserRepository();
  const replyPort = opts.replyPort ?? spyReplyPort();
  // This suite doesn't exercise the note/status/close routes — no-op fake ports are enough.
  const notePort = { addNote: async () => {} };
  const statusPort = { changeStatus: async () => {} };
  const closePort = { close: async () => {} };

  const submitSuricataVerdict = new SubmitSuricataVerdict(tickets, verdicts);
  const listSuricataTickets = new ListSuricataTickets(tickets, verdicts, areaRepo, rbacUserRepo);
  const getSuricataTicketDetail = new GetSuricataTicketDetail(tickets, messages, attachments, verdicts, areaRepo, rbacUserRepo);
  const computeSuricataKpis = new ComputeSuricataKpis(tickets, verdicts);
  const addSuricataInternalNote = new AddSuricataInternalNote(tickets, audits, notePort);
  const changeSuricataTicketStatus = new ChangeSuricataTicketStatus(tickets, audits, statusPort);
  const closeSuricataTicket = new CloseSuricataTicket(tickets, audits, closePort);
  const sendAutonomousSuricataReply = new SendAutonomousSuricataReply(tickets, audits, replyPort);

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
    sendAutonomousSuricataReply,
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

  return { app, tickets, audits, featureFlags, replyPort };
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

describe('POST /api/external/v1/suricata/tickets/:externalId/reply', () => {
  it('EXTREPLY-1 — missing token -> 401, before any driver call', async () => {
    const { app, replyPort } = buildApp();
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/reply')
      .send({ body: 'Ya reactivamos tu servicio' });
    expect(res.status).toBe(401);
    expect(replyPort.sendReplyCalls).toHaveLength(0);
  });

  it('EXTREPLY-1 — the GLOBAL external-v1 key (dedicated != global) is rejected with 401', async () => {
    const { app, tickets } = buildApp();
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/reply')
      .set('X-API-Key', GLOBAL_KEY)
      .send({ body: 'Ya reactivamos tu servicio' });
    expect(res.status).toBe(401);
  });

  it('EXTREPLY-2 — flag OFF -> 403 FEATURE_DISABLED, before any driver call, independent of the verdict flag (which stays ON)', async () => {
    const { app, tickets, replyPort } = buildApp({ replyFlagEnabled: false });
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/reply')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ body: 'Ya reactivamos tu servicio' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(replyPort.sendReplyCalls).toHaveLength(0);
  });

  it('EXTREPLY-2 — structurally independent of the INTERNAL suricata-reply-enabled flag: reply flag ON + internal flag OFF still succeeds', async () => {
    const { app, tickets } = buildApp({ replyFlagEnabled: true, internalReplyFlagEnabled: false });
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/reply')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ body: 'Ya reactivamos tu servicio' });
    expect(res.status).toBe(201);
  });

  it('EXTREPLY-2 — structurally independent of the INTERNAL suricata-reply-enabled flag: reply flag OFF + internal flag ON still 403s here', async () => {
    const { app, tickets } = buildApp({ replyFlagEnabled: false, internalReplyFlagEnabled: true });
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/reply')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ body: 'Ya reactivamos tu servicio' });
    expect(res.status).toBe(403);
  });

  it('EXTREPLY-3 — empty body -> 400, before any driver call and no audit row', async () => {
    const { app, tickets, audits, replyPort } = buildApp();
    const ticket = await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/reply')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ body: '' });
    expect(res.status).toBe(400);
    expect(replyPort.sendReplyCalls).toHaveLength(0);
    expect(await audits.listByTicket(ticket.id)).toHaveLength(0);
  });

  it('EXTREPLY-3 — missing body field -> 400, never 500', async () => {
    const { app, tickets } = buildApp();
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/reply')
      .set('X-API-Key', DEDICATED_KEY)
      .send({});
    expect(res.status).toBe(400);
  });

  it('EXTREPLY-3 — a `confirm` field is never read/required/validated: present-but-wrong confirm still succeeds', async () => {
    const { app, tickets } = buildApp();
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/reply')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ body: 'Ya reactivamos tu servicio', confirm: 'this-is-not-a-real-sha256' });
    expect(res.status).toBe(201);
  });

  it('unknown ticket externalId -> 404, no audit row', async () => {
    const { app, audits } = buildApp();
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ghost/reply')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ body: 'Ya reactivamos tu servicio' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SURICATA_TICKET_NOT_FOUND');
    expect(await audits.listByTicket('ghost')).toHaveLength(0);
  });

  it('success -> 201 with auditId, driver invoked with the exact body via the resolved conversationId', async () => {
    const replyPort = spyReplyPort({ conversationId: 'conv_99' });
    const { app, tickets } = buildApp({ replyPort });
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/reply')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ body: 'Ya reactivamos tu servicio' });
    expect(res.status).toBe(201);
    expect(res.body.auditId).toEqual(expect.any(String));
    expect(replyPort.getConversationIdCalls).toEqual(['ext-1']);
    expect(replyPort.sendReplyCalls).toEqual([['conv_99', 'Ya reactivamos tu servicio']]);
  });

  it('a ticket with no linked conversation -> 502, distinct failure, auditId present', async () => {
    const replyPort = spyReplyPort({ conversationId: null });
    const { app, tickets, audits } = buildApp({ replyPort });
    const ticket = await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/reply')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ body: 'Ya reactivamos tu servicio' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('SURICATA_ACTION_NOT_APPLIED');
    expect(res.body.auditId).toEqual(expect.any(String));
    const rows = await audits.listByTicket(ticket.id);
    expect(rows.some((r) => r.outcome === 'failed')).toBe(true);
  });

  it('driver failure -> 502 with auditId, audit row stays failed', async () => {
    const failingPort = spyReplyPort({
      conversationId: 'conv_1',
      send: async () => {
        throw new Error('Botpress request failed with status 500');
      },
    });
    const { app, tickets, audits } = buildApp({ replyPort: failingPort });
    const ticket = await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/reply')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ body: 'Ya reactivamos tu servicio' });
    expect(res.status).toBe(502);
    expect(res.body.auditId).toEqual(expect.any(String));
    const rows = await audits.listByTicket(ticket.id);
    expect(rows.some((r) => r.outcome === 'failed')).toBe(true);
  });

  it('independence — reply flag OFF while verdict flag stays ON does not block the pre-existing verdict route', async () => {
    const { app, tickets } = buildApp({ replyFlagEnabled: false });
    await seedTicket(tickets);
    const res = await request(app)
      .post('/api/external/v1/suricata/tickets/ext-1/verdict')
      .set('X-API-Key', DEDICATED_KEY)
      .send({ resuelto: true, analisis: 'todo resuelto' });
    expect(res.status).toBe(201);
  });
});

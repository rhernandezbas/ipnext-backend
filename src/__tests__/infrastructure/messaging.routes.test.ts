/**
 * messaging-inbox (F1, batch B6) — /api/messaging route integration tests. Seam
 * COMPLETO: use cases REALES + adapters in-memory + errorHandler REAL (mismo
 * convenio que actions.routes.test.ts). El webhook usa el `chatwootSignatureMiddleware`
 * REAL (no un stub) para pinear HOOK-1 a nivel ruta y RBAC-4 (bypass de sesión).
 */
import crypto from 'crypto';
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  createMessagingRouter,
  MessagingRoutePerms,
} from '../../infrastructure/http/routes/messaging.routes';
import {
  createChatwootSignatureMiddleware,
  rawBodyJsonParser,
} from '../../infrastructure/http/middleware/chatwootSignatureMiddleware';
import { createMessagingSendRateLimiter } from '../../infrastructure/http/middleware/rateLimiters';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { ReceiveChatwootWebhook } from '../../application/use-cases/messaging/ReceiveChatwootWebhook';
import { ListConversations } from '../../application/use-cases/messaging/ListConversations';
import { GetConversation } from '../../application/use-cases/messaging/GetConversation';
import { ListMessages } from '../../application/use-cases/messaging/ListMessages';
import { SendMessage } from '../../application/use-cases/messaging/SendMessage';
import { SetConversationStatus } from '../../application/use-cases/messaging/SetConversationStatus';
import { GetClientContextByPhone } from '../../application/use-cases/messaging/GetClientContextByPhone';
import { GetInboxClientContext } from '../../application/use-cases/messaging/GetInboxClientContext';
import { GetChatAttachmentFile } from '../../application/use-cases/messaging/GetChatAttachmentFile';
import { AssignConversation } from '../../application/use-cases/messaging/AssignConversation';
import { SetConversationArea } from '../../application/use-cases/messaging/SetConversationArea';
import { ListAssignableUsers } from '../../application/use-cases/messaging/ListAssignableUsers';
// inbox-template-send (HTTP-1/HTTP-2) — enviar template aprobado desde el hilo + catálogo curado.
import { SendTemplateMessage } from '../../application/use-cases/messaging/SendTemplateMessage';
import { ListTemplates } from '../../application/use-cases/messaging/ListTemplates';
import { InMemoryTemplateMessagingGateway } from '../../infrastructure/adapters/in-memory/InMemoryTemplateMessagingGateway';
import type { TemplateDto } from '../../domain/ports/TemplateMessagingPort';
import { GetClientContracts } from '../../application/use-cases/GetClientContracts';
import { GetClientInvoices } from '../../application/use-cases/GetClientInvoices';
import { GetClientLogs } from '../../application/use-cases/GetClientLogs';
import { ListTickets } from '../../application/use-cases/ListTickets';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { ListPppoeByContract } from '../../application/use-cases/ListPppoeByContract';
import { ListTicketAreas } from '../../application/use-cases/ListTicketAreas';
import { InMemoryConversationRepository } from '../../infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '../../infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryChatMessageAttachmentRepository } from '../../infrastructure/adapters/in-memory/InMemoryChatMessageAttachmentRepository';
import { InMemoryFileStorage } from '../../infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryWebhookDeliveryRepository } from '../../infrastructure/adapters/in-memory/InMemoryWebhookDeliveryRepository';
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryPppoeServiceRepository } from '../../infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryTicketAreaCatalogRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import { InMemoryRbacUserRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { FakeChatwootGateway } from '../helpers/FakeChatwootGateway';
import type { CustomerRepository, ActiveClientContact } from '../../domain/ports/CustomerRepository';
import type { Customer } from '../../domain/entities/customer';
import type { EntityLookup } from '../../domain/ports/EntityLookup';
import type { UserRoleLookup } from '../../domain/ports/UserRoleLookup';
import { config } from '../../infrastructure/config';

/** F1.5-C2 — fixed known-assignee pool (same "fixed ids matching the fixture" idiom
 * as `seedAdmins(['1','2'])` in tickets.routes.new.test.ts). */
const KNOWN_ASSIGNEES: Record<string, string> = { 'user-1': 'Agente Uno', 'user-2': 'Agente Dos' };

// Same "override config.chatwoot.webhookSecret per test" pattern as
// chatwootSignatureMiddleware.test.ts / apiKeyMiddleware.test.ts.
jest.mock('../../infrastructure/config', () => ({
  config: {
    chatwoot: { baseUrl: '', accountId: '', apiToken: '', inboxId: '', webhookSecret: '' },
  },
}));

const mockConfig = config as unknown as { chatwoot: { webhookSecret: string } };

const WEBHOOK_SECRET = 'test-webhook-secret';
const NOW_MS = 1_800_000_000_000; // fixed clock for deterministic HMAC/replay-window tests
const NOW_SEC = Math.floor(NOW_MS / 1000);

function sign(rawBody: Buffer, timestamp: string, secret = WEBHOOK_SECRET): string {
  const hex = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `sha256=${hex}`;
}

// ─── Auth + RBAC mock helpers (same idiom as actions.routes.test.ts) ────────────

const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: 'user-test', email: 'test@test.com' };
  next();
};

/** Proves RBAC-4: the webhook route never runs session auth, not even to reject it. */
const denyAuth: RequestHandler = (_req, res) => {
  res.status(401).json({ error: 'UNAUTHORIZED', code: 'NO_USER_CONTEXT' });
};

const denyPerm: RequestHandler = (_req, res, _next) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};

const allowPerm: RequestHandler = (_req, _res, next) => next();

function makeCustomerRepo(contacts: ActiveClientContact[] = [], overrides?: Partial<CustomerRepository>): CustomerRepository {
  return {
    listActiveContacts: jest.fn().mockResolvedValue(contacts),
    findById: jest.fn(),
    listContracts: jest.fn().mockResolvedValue([]),
    listInvoices: jest.fn().mockResolvedValue([]),
    listLogs: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 5 }),
    list: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn(),
    updateLocation: jest.fn(),
    ...overrides,
  } as unknown as CustomerRepository;
}

// ─── App factory (seam completo) ────────────────────────────────────────────────

interface BuildAppOptions {
  readPerm?: RequestHandler;
  sendPerm?: RequestHandler;
  auth?: RequestHandler;
  conversationRepo?: InMemoryConversationRepository;
  messageRepo?: InMemoryChatMessageRepository;
  deliveryRepo?: InMemoryWebhookDeliveryRepository;
  attachmentRepo?: InMemoryChatMessageAttachmentRepository;
  fileStorage?: InMemoryFileStorage;
  gateway?: FakeChatwootGateway;
  customerContacts?: ActiveClientContact[];
  /** messaging-inbox-v2 (F1.5, B4) — full CustomerRepository override for
   * client-context tests that need `findById`/`listContracts`/etc, not just
   * `listActiveContacts`. Takes precedence over `customerContacts`. */
  customerRepo?: CustomerRepository;
  ticketRepo?: InMemoryTicketRepository;
  schedulingRepo?: InMemorySchedulingRepository;
  pppoeRepo?: InMemoryPppoeServiceRepository;
  /** fix-be #2 [ALTO] — override the send-rate-limiter for tests that need a low
   * limit to actually trigger 429. Defaults to a permissive passthrough so the rest
   * of the suite (many requests per test file) never trips it by accident. */
  sendRateLimiter?: RequestHandler;
  // ─── F1.5-C2 (asignación) ───────────────────────────────────────────────────
  areaRepo?: InMemoryTicketAreaCatalogRepository;
  rbacUserRepo?: InMemoryRbacUserRepository;
  /** Defaults to a lookup that only knows KNOWN_ASSIGNEES ('user-1'/'user-2'). */
  assigneeLookup?: EntityLookup;
  /** Defaults to a lookup returning ['administrador'] for every user (non-technical). */
  roleLookup?: UserRoleLookup;
  // ─── inbox-template-send (HTTP-1/HTTP-2) ────────────────────────────────────
  templatePort?: InMemoryTemplateMessagingGateway;
  templates?: TemplateDto[];
}

function buildApp(opts: BuildAppOptions = {}) {
  mockConfig.chatwoot.webhookSecret = WEBHOOK_SECRET;

  const conversationRepo = opts.conversationRepo ?? new InMemoryConversationRepository();
  const messageRepo = opts.messageRepo ?? new InMemoryChatMessageRepository();
  const deliveryRepo = opts.deliveryRepo ?? new InMemoryWebhookDeliveryRepository();
  const attachmentRepo = opts.attachmentRepo ?? new InMemoryChatMessageAttachmentRepository();
  const fileStorage = opts.fileStorage ?? new InMemoryFileStorage();
  const gateway = opts.gateway ?? new FakeChatwootGateway();
  const customerRepo = opts.customerRepo ?? makeCustomerRepo(opts.customerContacts);
  const ticketRepo = opts.ticketRepo ?? new InMemoryTicketRepository();
  const schedulingRepo = opts.schedulingRepo ?? new InMemorySchedulingRepository();
  const pppoeRepo = opts.pppoeRepo ?? new InMemoryPppoeServiceRepository();
  const getClientContext = new GetClientContextByPhone(customerRepo);

  // ─── F1.5-C2 (asignación) ───────────────────────────────────────────────────
  const areaRepo = opts.areaRepo ?? new InMemoryTicketAreaCatalogRepository();
  const rbacUserRepo = opts.rbacUserRepo ?? new InMemoryRbacUserRepository();
  // `seedAreas` links a LIVE repo reference (areas created after this call still
  // resolve) — `seedUsers` is a static snapshot (same "fixed ids" idiom as
  // InMemoryTicketRepository.seedAdmins), so only KNOWN_ASSIGNEES resolve a name.
  conversationRepo.seedAreas(areaRepo);
  conversationRepo.seedUsers(Object.entries(KNOWN_ASSIGNEES).map(([id, name]) => ({ id, name })));
  const assigneeLookup: EntityLookup =
    opts.assigneeLookup ??
    {
      findById: async (id: string) => (id in KNOWN_ASSIGNEES ? { id, name: KNOWN_ASSIGNEES[id] } : null),
    };
  const roleLookup: UserRoleLookup = opts.roleLookup ?? { listRoleCodes: async () => ['administrador'] };

  // ─── inbox-template-send (HTTP-1/HTTP-2) ────────────────────────────────────
  const templatePort = opts.templatePort ?? new InMemoryTemplateMessagingGateway({ templates: opts.templates });

  const getInboxClientContext = new GetInboxClientContext(
    conversationRepo,
    getClientContext,
    customerRepo,
    new GetClientContracts(customerRepo),
    new GetClientInvoices(customerRepo),
    new GetClientLogs(customerRepo),
    new ListTickets(ticketRepo),
    ticketRepo,
    new ListTasks(schedulingRepo),
    new ListPppoeByContract(pppoeRepo),
  );

  const perms: MessagingRoutePerms = {
    read: opts.readPerm ?? allowPerm,
    send: opts.sendPerm ?? allowPerm,
  };

  const app = express();
  // Same raw-body-before-global-json ordering as app.ts (:829/:830) — the webhook
  // path MUST see the untouched bytes via req.rawBody before any parser mutates it.
  app.use('/api/messaging/webhook', rawBodyJsonParser());
  app.use(express.json());
  app.use(
    '/api/messaging',
    createMessagingRouter(
      new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo, attachmentRepo),
      new ListConversations(conversationRepo),
      new GetConversation(conversationRepo, messageRepo, gateway, getClientContext, attachmentRepo),
      new ListMessages(conversationRepo, messageRepo, attachmentRepo),
      new SendMessage(conversationRepo, messageRepo, gateway, attachmentRepo),
      new SetConversationStatus(conversationRepo, gateway),
      getInboxClientContext,
      new GetChatAttachmentFile(attachmentRepo, fileStorage),
      createChatwootSignatureMiddleware({ now: () => NOW_MS }),
      opts.auth ?? allowAuth,
      perms,
      // fix-be #2 [ALTO] — permissive by default (the rest of this file fires many
      // requests per test); tests targeting the limiter itself override it.
      opts.sendRateLimiter ?? allowPerm,
      // F1.5-C2 (asignación) — LOCAL-only, sin llamada a Chatwoot.
      new AssignConversation(conversationRepo, assigneeLookup),
      new SetConversationArea(conversationRepo, areaRepo),
      new ListAssignableUsers(rbacUserRepo, roleLookup),
      new ListTicketAreas(areaRepo),
      // inbox-template-send (HTTP-1/HTTP-2) — appended (design §Colisiones: nunca
      // insertar en medio de la lista compartida con inbox-resolve).
      new SendTemplateMessage(conversationRepo, templatePort, messageRepo),
      new ListTemplates(templatePort),
    ),
  );
  app.use(errorHandler);

  return {
    app,
    conversationRepo,
    messageRepo,
    deliveryRepo,
    attachmentRepo,
    fileStorage,
    gateway,
    customerRepo,
    ticketRepo,
    schedulingRepo,
    pppoeRepo,
    areaRepo,
    rbacUserRepo,
    templatePort,
  };
}

// ─── RBAC gates (RBAC-1/2) ───────────────────────────────────────────────────────

describe('/api/messaging — RBAC', () => {
  it('GET /conversations sin messaging:read → 403', async () => {
    const { app } = buildApp({ readPerm: denyPerm });
    const res = await request(app).get('/api/messaging/conversations');
    expect(res.status).toBe(403);
  });

  it('GET /conversations/:id sin messaging:read → 403', async () => {
    const { app } = buildApp({ readPerm: denyPerm });
    const res = await request(app).get('/api/messaging/conversations/conv-1');
    expect(res.status).toBe(403);
  });

  it('GET /conversations/:id/messages sin messaging:read → 403', async () => {
    const { app } = buildApp({ readPerm: denyPerm });
    const res = await request(app).get('/api/messaging/conversations/conv-1/messages');
    expect(res.status).toBe(403);
  });

  it('POST /conversations/:id/messages con SOLO messaging:read (sin send) → 403 sin llamar a Chatwoot (RBAC-2)', async () => {
    const { app, gateway } = buildApp({ sendPerm: denyPerm });
    const res = await request(app)
      .post('/api/messaging/conversations/conv-1/messages')
      .send({ content: 'hola' });

    expect(res.status).toBe(403);
    expect(gateway.sendMessageCalls).toHaveLength(0);
  });

  it('POST /conversations/:id/status con SOLO messaging:read (sin send) → 403 sin llamar a Chatwoot (mismo permiso que el envío)', async () => {
    const { app, gateway } = buildApp({ sendPerm: denyPerm });
    const res = await request(app)
      .post('/api/messaging/conversations/conv-1/status')
      .send({ status: 'resolved' });

    expect(res.status).toBe(403);
    expect(gateway.setStatusCalls).toHaveLength(0);
  });

  // ─── F1.5-C2 (asignación) — RBAC ────────────────────────────────────────────

  it('PATCH /conversations/:id/assignee con SOLO messaging:read (sin send) → 403', async () => {
    const { app } = buildApp({ sendPerm: denyPerm });
    const res = await request(app)
      .patch('/api/messaging/conversations/conv-1/assignee')
      .send({ assigneeId: 'user-1' });
    expect(res.status).toBe(403);
  });

  it('PATCH /conversations/:id/area con SOLO messaging:read (sin send) → 403', async () => {
    const { app } = buildApp({ sendPerm: denyPerm });
    const res = await request(app)
      .patch('/api/messaging/conversations/conv-1/area')
      .send({ areaId: 'area-1' });
    expect(res.status).toBe(403);
  });

  it('GET /assignable-users sin messaging:read → 403', async () => {
    const { app } = buildApp({ readPerm: denyPerm });
    const res = await request(app).get('/api/messaging/assignable-users');
    expect(res.status).toBe(403);
  });

  it('GET /areas sin messaging:read → 403', async () => {
    const { app } = buildApp({ readPerm: denyPerm });
    const res = await request(app).get('/api/messaging/areas');
    expect(res.status).toBe(403);
  });
});

// ─── RBAC-4: webhook no usa RBAC/sesión de usuario ──────────────────────────────

describe('POST /api/messaging/webhook — RBAC-4 (M2M, HMAC-only)', () => {
  it('procesa el webhook SIN sesión: la firma HMAC válida basta incluso si auth() rechazaría', async () => {
    const { app, conversationRepo } = buildApp({ auth: denyAuth });
    const payload = { event: 'conversation_created', id: 77, status: 'open' };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestamp = String(NOW_SEC);

    const res = await request(app)
      .post('/api/messaging/webhook')
      .set('x-chatwoot-signature', sign(rawBody, timestamp))
      .set('x-chatwoot-timestamp', timestamp)
      .set('x-chatwoot-delivery', 'delivery-1')
      .send(payload);

    expect(res.status).toBe(200);
    const conv = await conversationRepo.findByChatwootId(77);
    expect(conv).not.toBeNull();
  });

  it('firma inválida → 401 INVALID_SIGNATURE, no toca el mirror', async () => {
    const { app, conversationRepo } = buildApp();
    const payload = { event: 'conversation_created', id: 78, status: 'open' };
    const timestamp = String(NOW_SEC);

    const res = await request(app)
      .post('/api/messaging/webhook')
      .set('x-chatwoot-signature', 'sha256=' + 'deadbeef'.repeat(8))
      .set('x-chatwoot-timestamp', timestamp)
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_SIGNATURE');
    expect(await conversationRepo.findByChatwootId(78)).toBeNull();
  });

  it('X-Chatwoot-Delivery ausente → igual se procesa (dedup se saltea, no bloquea)', async () => {
    const { app, conversationRepo } = buildApp();
    const payload = { event: 'conversation_created', id: 79, status: 'open' };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestamp = String(NOW_SEC);

    const res = await request(app)
      .post('/api/messaging/webhook')
      .set('x-chatwoot-signature', sign(rawBody, timestamp))
      .set('x-chatwoot-timestamp', timestamp)
      .send(payload);

    expect(res.status).toBe(200);
    expect(await conversationRepo.findByChatwootId(79)).not.toBeNull();
  });

  it('delivery duplicado → 200 sin reprocesar (HOOK-3)', async () => {
    const { app, conversationRepo } = buildApp();
    const payload = { event: 'conversation_status_changed', id: 80, status: 'resolved' };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestamp = String(NOW_SEC);

    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 80, status: 'open' });

    const send = () =>
      request(app)
        .post('/api/messaging/webhook')
        .set('x-chatwoot-signature', sign(rawBody, timestamp))
        .set('x-chatwoot-timestamp', timestamp)
        .set('x-chatwoot-delivery', 'dup-1')
        .send(payload);

    const first = await send();
    expect(first.status).toBe(200);
    expect((await conversationRepo.findByChatwootId(80))?.status).toBe('resolved');

    // Reopen the mirror row directly to prove the SECOND delivery never re-applies the event.
    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 80, status: 'open' });
    const second = await send();
    expect(second.status).toBe(200);
    expect((await conversationRepo.findByChatwootId(80))?.status).toBe('open');
  });

  it('no cuelga cuando el deliveryRepo lanza (ROB-1): responde 500 inmediato', async () => {
    class ThrowingDeliveryRepo extends InMemoryWebhookDeliveryRepository {
      override async recordIfNew(): Promise<boolean> {
        throw new Error('db down');
      }
    }
    const { app } = buildApp({ deliveryRepo: new ThrowingDeliveryRepo() });
    const payload = { event: 'conversation_created', id: 81, status: 'open' };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestamp = String(NOW_SEC);

    const res = await request(app)
      .post('/api/messaging/webhook')
      .set('x-chatwoot-signature', sign(rawBody, timestamp))
      .set('x-chatwoot-timestamp', timestamp)
      .set('x-chatwoot-delivery', 'delivery-throw')
      .send(payload);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

// ─── H10 — dedup deriva del CONTENIDO firmado, no del header unsigned ───────────

describe('POST /api/messaging/webhook — dedup por contenido firmado (H10, anti-replay)', () => {
  // NOTE: a plain "message count stays at 1" assertion does NOT discriminate this
  // bug — `ChatMessage.upsertByChatwootMessageId`/`Conversation.upsertByChatwootId`
  // are ALREADY idempotent by chatwootMessageId/chatwootConversationId regardless of
  // webhook-level dedup, so reprocessing a message_created converges to the same
  // row either way. The actual observable risk is a STALE replay re-applying an
  // event AFTER a legitimate SUBSEQUENT event already moved the state forward —
  // same technique as the HOOK-3 "delivery duplicado" test above, but proving it
  // holds even WITHOUT relying on the (attacker-strippable) delivery header.

  it('replay de conversation_status_changed SIN header de delivery no revierte un estado ya avanzado por un evento legítimo posterior', async () => {
    const { app, conversationRepo } = buildApp();
    const payload = { event: 'conversation_status_changed', id: 210, status: 'resolved' };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestamp = String(NOW_SEC);
    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 210, status: 'open' });

    // Captured-and-replayed request: valid signature (same raw bytes), valid
    // timestamp (still inside the ±5min window), NO `X-Chatwoot-Delivery` header —
    // before the fix, the route fell back to `randomUUID()` per request, so this
    // exact scenario NEVER deduped.
    const send = () =>
      request(app)
        .post('/api/messaging/webhook')
        .set('x-chatwoot-signature', sign(rawBody, timestamp))
        .set('x-chatwoot-timestamp', timestamp)
        .send(payload);

    const first = await send();
    expect(first.status).toBe(200);
    expect((await conversationRepo.findByChatwootId(210))?.status).toBe('resolved');

    // A legitimate SUBSEQUENT event reopens the conversation.
    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 210, status: 'open' });

    // Replay of the FIRST captured request — must be deduped by CONTENT alone.
    const second = await send();
    expect(second.status).toBe(200);
    expect((await conversationRepo.findByChatwootId(210))?.status).toBe('open'); // NOT reset back to 'resolved'
  });

  it('mismo replay pero con headers DISTINTOS (header alterado/removido) igual dedupea por contenido, no por el header', async () => {
    const { app, conversationRepo } = buildApp();
    const payload = { event: 'conversation_status_changed', id: 211, status: 'resolved' };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const timestamp = String(NOW_SEC);
    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 211, status: 'open' });

    const first = await request(app)
      .post('/api/messaging/webhook')
      .set('x-chatwoot-signature', sign(rawBody, timestamp))
      .set('x-chatwoot-timestamp', timestamp)
      .set('x-chatwoot-delivery', 'attacker-controlled-header-1')
      .send(payload);
    expect(first.status).toBe(200);
    expect((await conversationRepo.findByChatwootId(211))?.status).toBe('resolved');

    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 211, status: 'open' });

    const second = await request(app)
      .post('/api/messaging/webhook')
      .set('x-chatwoot-signature', sign(rawBody, timestamp))
      .set('x-chatwoot-timestamp', timestamp)
      .set('x-chatwoot-delivery', 'attacker-controlled-header-2') // header stripped/altered on replay
      .send(payload);
    expect(second.status).toBe(200);
    expect((await conversationRepo.findByChatwootId(211))?.status).toBe('open'); // dedup held despite header mismatch
  });

  it('dos message_created REALMENTE distintos (message.id distinto) NO se pisan entre si', async () => {
    const { app, conversationRepo, messageRepo } = buildApp();
    const timestamp = String(NOW_SEC);
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 202 });

    for (const id of [5003, 5004]) {
      const payload = {
        event: 'message_created',
        id,
        content: `mensaje ${id}`,
        message_type: 'incoming',
        created_at: NOW_SEC,
        conversation: { id: 202 },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const res = await request(app)
        .post('/api/messaging/webhook')
        .set('x-chatwoot-signature', sign(rawBody, timestamp))
        .set('x-chatwoot-timestamp', timestamp)
        .send(payload);
      expect(res.status).toBe(200);
    }

    const messages = await messageRepo.listByConversation(conv.id);
    expect(messages).toHaveLength(2);
  });

  it('#10 residual — oscilacion resolved -> open -> resolved (3 entregas REALMENTE distintas, timestamps distintos) no descarta el 2do resolve', async () => {
    const { app, conversationRepo } = buildApp();
    await conversationRepo.upsertByChatwootId({ chatwootConversationId: 220, status: 'open' });

    const sendStatus = (status: string, timestampSec: number) => {
      const payload = { event: 'conversation_status_changed', id: 220, status };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const timestamp = String(timestampSec);
      return request(app)
        .post('/api/messaging/webhook')
        .set('x-chatwoot-signature', sign(rawBody, timestamp))
        .set('x-chatwoot-timestamp', timestamp)
        .send(payload);
    };

    const first = await sendStatus('resolved', NOW_SEC);
    expect(first.status).toBe(200);
    expect((await conversationRepo.findByChatwootId(220))?.status).toBe('resolved');

    const second = await sendStatus('open', NOW_SEC + 1);
    expect(second.status).toBe(200);
    expect((await conversationRepo.findByChatwootId(220))?.status).toBe('open');

    // Antes del fix, la clave de dedup era `conversation_status_changed:220:resolved`,
    // IDENTICA a la de `first` (mismo conversationId + mismo status), pese a ser una
    // entrega real y distinta (otro timestamp firmado) -> se descartaba como "ya visto"
    // y el mirror quedaba stale en 'open'.
    const third = await sendStatus('resolved', NOW_SEC + 2);
    expect(third.status).toBe(200);
    expect((await conversationRepo.findByChatwootId(220))?.status).toBe('resolved');
  });
});

// ─── GET /conversations (INBOX-1) ────────────────────────────────────────────────

describe('GET /api/messaging/conversations', () => {
  it('página vacía → 200 con data: []', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/conversations');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('200 con conversaciones mapeadas a DTO, ordenadas por lastMessageAt DESC', async () => {
    const { app, conversationRepo } = buildApp();
    await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 1, contactPhone: '+549111', lastMessageAt: '2026-07-01T00:00:00.000Z',
    });
    await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 2, contactPhone: '+549222', lastMessageAt: '2026-07-10T00:00:00.000Z',
    });

    const res = await request(app).get('/api/messaging/conversations');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].contactPhone).toBe('+549222'); // most recent first
    expect(res.body.data[0]).not.toHaveProperty('chatwootConversationId'); // never the raw mirror row
  });

  it('no cuelga cuando el repo lanza (ROB-1): responde 500 inmediato', async () => {
    class ThrowingConversationRepo extends InMemoryConversationRepository {
      override async list(): Promise<never> {
        throw new Error('db down');
      }
    }
    const { app } = buildApp({ conversationRepo: new ThrowingConversationRepo() });
    const res = await request(app).get('/api/messaging/conversations');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

// ─── GET /conversations/:id (INBOX-2) ────────────────────────────────────────────

describe('GET /api/messaging/conversations/:id', () => {
  it('id inexistente → 404 CONVERSATION_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/conversations/ghost');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('200 con detalle + clientContext, sync fresh de Chatwoot vía fetch-on-open', async () => {
    const { app, conversationRepo, gateway } = buildApp({
      customerContacts: [{ id: 'c1', name: 'Juan Perez', phone: '+5492324421234', email: null }],
    });
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 5, contactPhone: '02324 421234', canReply: false,
    });
    gateway.conversationsById.set(5, {
      id: 5, contactName: 'Juan', contactPhone: '02324 421234', status: 'open', canReply: true, lastActivityAt: null,
    });
    gateway.messagesById.set(5, []);

    const res = await request(app).get(`/api/messaging/conversations/${conv.id}`);

    expect(res.status).toBe(200);
    expect(res.body.canReply).toBe(true); // refreshed by fetch-on-open
    expect(res.body.clientContext).toEqual({ status: 'matched', clients: [{ id: 'c1', name: 'Juan Perez', status: 'active' }] });
  });

  it('Chatwoot caído durante fetch-on-open → 200 sirve el snapshot del mirror, nunca 500 (INBOX-2)', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    gateway.failGetConversation = true;
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 6, contactName: 'Stale', canReply: true,
    });

    const res = await request(app).get(`/api/messaging/conversations/${conv.id}`);

    expect(res.status).toBe(200);
    expect(res.body.contactName).toBe('Stale');
  });
});

// ─── GET /conversations/:id/messages (INBOX-3) ───────────────────────────────────

describe('GET /api/messaging/conversations/:id/messages', () => {
  it('conversación sin mensajes → 200 con data: []', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 9 });
    const res = await request(app).get(`/api/messaging/conversations/${conv.id}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('historial ASC con direction por mensaje, sin ids internos de Chatwoot como pk', async () => {
    const { app, conversationRepo, messageRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 10 });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: conv.id, chatwootMessageId: 200, direction: 'outbound', content: 'segundo',
      senderName: null, chatwootCreatedAt: '2026-07-02T00:00:00.000Z',
    });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: conv.id, chatwootMessageId: 100, direction: 'inbound', content: 'primero',
      senderName: 'Cliente', chatwootCreatedAt: '2026-07-01T00:00:00.000Z',
    });

    const res = await request(app).get(`/api/messaging/conversations/${conv.id}/messages`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ direction: 'inbound', content: 'primero' });
    expect(res.body.data[1]).toMatchObject({ direction: 'outbound', content: 'segundo' });
    expect(res.body.data[0]).not.toHaveProperty('chatwootMessageId');
  });

  it('conversación inexistente → 404', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/conversations/ghost/messages');
    expect(res.status).toBe(404);
  });
});

// ─── POST /conversations/:id/messages (SEND-1/2/3) ───────────────────────────────

describe('POST /api/messaging/conversations/:id/messages', () => {
  it('dentro de ventana (canReply=true) → 201 con el DTO del mensaje creado, llama a Chatwoot', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 11, canReply: true });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .send({ content: 'Hola, como estas?' });

    expect(res.status).toBe(201);
    expect(res.body.direction).toBe('outbound');
    expect(gateway.sendMessageCalls).toEqual([{ chatwootConversationId: 11, content: 'Hola, como estas?' }]);
  });

  it('fuera de ventana / sin inbound (canReply=false) → 422 MESSAGING_WINDOW_EXPIRED sin llamar a Chatwoot (SEND-2)', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 12 }); // canReply default false

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .send({ content: 'tarde' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MESSAGING_WINDOW_EXPIRED');
    expect(gateway.sendMessageCalls).toHaveLength(0);
  });

  it('Chatwoot inalcanzable al enviar → 503 CHATWOOT_UNAVAILABLE sin upsert en el mirror (SEND-3)', async () => {
    const { app, conversationRepo, messageRepo, gateway } = buildApp();
    gateway.failSendMessage = true;
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 13, canReply: true });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .send({ content: 'hola' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CHATWOOT_UNAVAILABLE');
    expect(await messageRepo.listByConversation(conv.id)).toEqual([]);
  });

  it('content vacío → 400 VALIDATION_ERROR sin llamar a Chatwoot', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 14, canReply: true });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .send({ content: '  ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(gateway.sendMessageCalls).toHaveLength(0);
  });

  it('conversación inexistente → 404', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/messaging/conversations/ghost/messages')
      .send({ content: 'hola' });
    expect(res.status).toBe(404);
  });
});

// ─── POST /conversations/:id/messages — multipart (messaging-inbox-v2-media, Tanda 2 · SEND-6) ──

describe('POST /api/messaging/conversations/:id/messages — multipart (BE3)', () => {
  it('multipart con caption + 2 attachments → 201 poblado', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 30, canReply: true });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .field('content', 'mirá esto')
      .attach('attachments', Buffer.from('img-bytes'), { filename: 'foto.jpg', contentType: 'image/jpeg' })
      .attach('attachments', Buffer.from('pdf-bytes'), { filename: 'factura.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(res.body.content).toBe('mirá esto');
    expect(res.body.attachments).toHaveLength(2);
    expect(gateway.sendMessageCalls).toEqual([
      expect.objectContaining({ chatwootConversationId: 30, content: 'mirá esto', files: 2 }),
    ]);
  });

  it('multipart solo attachments, sin caption → 201, content=""', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 31, canReply: true });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .attach('attachments', Buffer.from('img-bytes'), { filename: 'foto.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.content).toBe('');
    expect(res.body.attachments).toHaveLength(1);
  });

  it('ni content ni attachments → 400 VALIDATION_ERROR, sendMessage.execute NUNCA invocado (#12)', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 32, canReply: true });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .field('foo', 'bar');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(gateway.sendMessageCalls).toHaveLength(0);
  });

  it('11 archivos → 400 TOO_MANY_FILES (LIMIT_FILE_COUNT), sin llegar al use case (#13)', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 33, canReply: true });

    let req = request(app).post(`/api/messaging/conversations/${conv.id}/messages`);
    for (let i = 0; i < 11; i++) {
      req = req.attach('attachments', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: `f${i}.jpg`, contentType: 'image/jpeg' });
    }
    const res = await req;

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOO_MANY_FILES');
    expect(gateway.sendMessageCalls).toHaveLength(0);
  });

  it('archivo >100MB → 413 FILE_TOO_LARGE a nivel multer, ANTES del handler/use case (#14)', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 34, canReply: true });
    const big = Buffer.alloc(100 * 1024 * 1024 + 1, 0x41);

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .attach('attachments', big, { filename: 'big.bin', contentType: 'application/octet-stream' });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
    expect(gateway.sendMessageCalls).toHaveLength(0);
  }, 20000);

  it('POST JSON texto-solo — passthrough sin regresión (#15)', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 35, canReply: true });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .send({ content: 'hola' });

    expect(res.status).toBe(201);
    expect(res.body.content).toBe('hola');
    expect(gateway.sendMessageCalls).toEqual([
      expect.objectContaining({ chatwootConversationId: 35, content: 'hola' }),
    ]);
  });

  it('fix-be #2 [ALTO] — 2 archivos c/u bajo el límite POR ARCHIVO (100MB) pero cuyo TOTAL supera el cap del batch → 413 BATCH_TOO_LARGE, sin llegar al use case', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 36, canReply: true });
    // 60MB + 60MB = 120MB > 100MB (MAX_TOTAL_BATCH_BYTES), pero cada uno < 100MB
    // (MAX_FILE_BYTES) — antes del fix, multer los dejaba pasar los dos sin techo
    // sobre el TOTAL (hasta 1GB en RAM con 10 archivos así).
    const chunk = Buffer.alloc(60 * 1024 * 1024, 0x41);

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .attach('attachments', chunk, { filename: 'a.bin', contentType: 'application/octet-stream' })
      .attach('attachments', chunk, { filename: 'b.bin', contentType: 'application/octet-stream' });

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BATCH_TOO_LARGE');
    expect(gateway.sendMessageCalls).toHaveLength(0);
  }, 30000);

  it('fix-be #3 [BAJO] — field name inesperado (no "attachments") → 400 UNEXPECTED_FIELD, distinto del mensaje engañoso de TOO_MANY_FILES', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 37, canReply: true });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .field('content', 'hola')
      .attach('archivo-inesperado', Buffer.from('x'), { filename: 'x.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNEXPECTED_FIELD');
    expect(res.body.code).not.toBe('TOO_MANY_FILES');
    expect(gateway.sendMessageCalls).toHaveLength(0);
  });

  it('fix-be #2 [ALTO] — rate-limiter dedicado dispara 429 RATE_LIMITED tras superar el cupo en requests CON adjuntos (multipart), sin llegar al use case', async () => {
    const { app, conversationRepo, gateway } = buildApp({
      sendRateLimiter: createMessagingSendRateLimiter({ limit: 2, windowMs: 60_000 }),
    });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 38, canReply: true });

    // fix-be micro (re-review adversarial, Tanda 2) — el limiter existe para el DoS
    // de MEDIA (uploads grandes); el gate SOLO debe consumir cupo en requests
    // multipart (con adjuntos), nunca en texto-solo. Se prueba acá con `.attach(...)`.
    const send = () =>
      request(app)
        .post(`/api/messaging/conversations/${conv.id}/messages`)
        .field('content', 'hola')
        .attach('attachments', Buffer.from('x'), { filename: 'x.jpg', contentType: 'image/jpeg' });

    const first = await send();
    const second = await send();
    const third = await send();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('RATE_LIMITED');
    expect(gateway.sendMessageCalls).toHaveLength(2); // el 3ro nunca llega al use case
  });

  it('fix-be micro [re-review adversarial] — texto-solo (JSON, sin adjuntos) NUNCA consume el cupo del rate-limiter — regresión F1 (F1 no tenía límite en el camino de texto)', async () => {
    const { app, conversationRepo, gateway } = buildApp({
      sendRateLimiter: createMessagingSendRateLimiter({ limit: 2, windowMs: 60_000 }),
    });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 39, canReply: true });

    const send = () => request(app).post(`/api/messaging/conversations/${conv.id}/messages`).send({ content: 'hola' });

    const first = await send();
    const second = await send();
    const third = await send();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(201); // texto-solo pasa SIEMPRE, aunque supere el cupo
    expect(gateway.sendMessageCalls).toHaveLength(3);
  });
});

// ─── POST /conversations/:id/messages — nota privada (messaging-inbox-notes, SEND-1
// MODIFIED / NOTE-3/6/7) ──────────────────────────────────────────────────────────

describe('POST /api/messaging/conversations/:id/messages — nota privada (NOTE-6/7)', () => {
  it('JSON con private:true + canReply=false → 201 (bypass, NUNCA 422), Chatwoot recibe private:true', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 50 }); // canReply default false

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .send({ content: 'nota interna', private: true });

    expect(res.status).toBe(201);
    expect(res.body.private).toBe(true);
    expect(gateway.sendMessageCalls).toEqual([
      expect.objectContaining({ chatwootConversationId: 50, content: 'nota interna', private: true }),
    ]);
  });

  it('multipart con field private=true + canReply=false → 201 (bypass)', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 51 });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .field('content', 'nota interna multipart')
      .field('private', 'true');

    expect(res.status).toBe(201);
    expect(res.body.private).toBe(true);
    expect(gateway.sendMessageCalls).toEqual([
      expect.objectContaining({ chatwootConversationId: 51, content: 'nota interna multipart', private: true }),
    ]);
  });

  it('ausencia de private → sendMessage.execute recibe isPrivate:false, comportamiento F1.5 idéntico (canReply=false SIGUE dando 422)', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 52 }); // canReply default false

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .send({ content: 'reply normal' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MESSAGING_WINDOW_EXPIRED');
  });

  it('NOTE-3: una nota privada enviada NO bumpea lastMessagePreview/lastMessageAt de la conversación', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 53,
      lastMessagePreview: 'Hola',
      lastMessageAt: '2026-07-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .send({ content: 'nota interna', private: true });

    expect(res.status).toBe(201);
    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.lastMessagePreview).toBe('Hola');
    expect(updated!.lastMessageAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('un mensaje normal enviado (private ausente) SIGUE bumpeando el preview — regresión F1.5', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 54, canReply: true });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .send({ content: 'reply normal' });

    expect(res.status).toBe(201);
    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.lastMessagePreview).toBe('reply normal');
  });

  it('NOTE-7 — sin messaging:send, nota privada → 403 sin llamar a Chatwoot (mismo guard messaging:send, sin permiso separado)', async () => {
    const { app, conversationRepo, gateway } = buildApp({ sendPerm: denyPerm });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 55, canReply: true });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/messages`)
      .send({ content: 'nota interna', private: true });

    expect(res.status).toBe(403);
    expect(gateway.sendMessageCalls).toHaveLength(0);
  });
});

// ─── POST /conversations/:id/status (messaging-inbox-productivity, F1.5 fase C,
// STATUS-1) — resolver/reabrir/marcar pendiente ─────────────────────────────────

describe('POST /api/messaging/conversations/:id/status', () => {
  it('status válido (resolved) → 200 con la conversación actualizada (DTO), el mirror refleja el cambio', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 60, status: 'open' });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/status`)
      .send({ status: 'resolved' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: conv.id, status: 'resolved' });
    expect(gateway.setStatusCalls).toEqual([{ chatwootConversationId: 60, status: 'resolved' }]);
    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.status).toBe('resolved');
  });

  it.each(['open', 'resolved', 'pending'])('acepta status "%s"', async (status) => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 61 });

    const res = await request(app).post(`/api/messaging/conversations/${conv.id}/status`).send({ status });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(status);
  });

  it('status inválido → 400 VALIDATION_ERROR sin llamar a Chatwoot', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 62 });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/status`)
      .send({ status: 'closed' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(gateway.setStatusCalls).toHaveLength(0);
  });

  it('status ausente → 400 VALIDATION_ERROR', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 63 });

    const res = await request(app).post(`/api/messaging/conversations/${conv.id}/status`).send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(gateway.setStatusCalls).toHaveLength(0);
  });

  it('conversación inexistente → 404 CONVERSATION_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/messaging/conversations/ghost/status')
      .send({ status: 'resolved' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('Chatwoot inalcanzable → 503 CHATWOOT_UNAVAILABLE, mirror NO se toca', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    gateway.failSetStatus = true;
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 64, status: 'open' });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/status`)
      .send({ status: 'resolved' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('CHATWOOT_UNAVAILABLE');
    const stillOpen = await conversationRepo.findById(conv.id);
    expect(stillOpen!.status).toBe('open');
  });

  it('sin sesión (auth deniega) → 401', async () => {
    const { app, conversationRepo } = buildApp({ auth: denyAuth });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 65 });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/status`)
      .send({ status: 'resolved' });

    expect(res.status).toBe(401);
  });

  it('resolver NO toca canReply (independiente de la ventana de 24h)', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 66,
      status: 'open',
      canReply: false,
    });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/status`)
      .send({ status: 'resolved' });

    expect(res.status).toBe(200);
    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.canReply).toBe(false);
  });
});

// ─── PATCH /conversations/:id/assignee (F1.5-C2, asignación) ────────────────────

describe('PATCH /api/messaging/conversations/:id/assignee', () => {
  it('assigneeId válido → 200 con el DTO actualizado (assignee poblado), LOCAL sin llamar a Chatwoot', async () => {
    const { app, conversationRepo, gateway } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 70, status: 'open' });

    const res = await request(app)
      .patch(`/api/messaging/conversations/${conv.id}/assignee`)
      .send({ assigneeId: 'user-1' });

    expect(res.status).toBe(200);
    expect(res.body.assignee).toEqual({ id: 'user-1', name: 'Agente Uno' });
    expect(gateway.setStatusCalls).toHaveLength(0); // NUNCA llama a Chatwoot
    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.assigneeId).toBe('user-1');
  });

  it('assigneeId: null → 200, desasigna', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 71 });
    await conversationRepo.updateLocalFields(conv.id, { assigneeId: 'user-1' });

    const res = await request(app)
      .patch(`/api/messaging/conversations/${conv.id}/assignee`)
      .send({ assigneeId: null });

    expect(res.status).toBe(200);
    expect(res.body.assignee).toBeNull();
  });

  it('assigneeId ausente en el body → 400 VALIDATION_ERROR', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 72 });

    const res = await request(app).patch(`/api/messaging/conversations/${conv.id}/assignee`).send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('assigneeId con tipo inválido (number) → 400 VALIDATION_ERROR', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 73 });

    const res = await request(app)
      .patch(`/api/messaging/conversations/${conv.id}/assignee`)
      .send({ assigneeId: 123 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('conversación inexistente → 404 CONVERSATION_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/messaging/conversations/ghost/assignee')
      .send({ assigneeId: 'user-1' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('assigneeId inexistente → 404 USER_NOT_FOUND, mirror SIN tocar', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 74 });

    const res = await request(app)
      .patch(`/api/messaging/conversations/${conv.id}/assignee`)
      .send({ assigneeId: 'ghost-user' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
    const stillUnassigned = await conversationRepo.findById(conv.id);
    expect(stillUnassigned!.assigneeId).toBeNull();
  });

  it('sin sesión (auth deniega) → 401', async () => {
    const { app, conversationRepo } = buildApp({ auth: denyAuth });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 75 });

    const res = await request(app)
      .patch(`/api/messaging/conversations/${conv.id}/assignee`)
      .send({ assigneeId: 'user-1' });

    expect(res.status).toBe(401);
  });
});

// ─── PATCH /conversations/:id/area (F1.5-C2, asignación) ────────────────────────

describe('PATCH /api/messaging/conversations/:id/area', () => {
  it('areaId válido → 200 con el DTO actualizado (area poblada), LOCAL sin llamar a Chatwoot', async () => {
    const { app, conversationRepo, areaRepo, gateway } = buildApp();
    const area = await areaRepo.create({ name: 'Soporte', color: '#ff0000' });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 80, status: 'open' });

    const res = await request(app)
      .patch(`/api/messaging/conversations/${conv.id}/area`)
      .send({ areaId: area.id });

    expect(res.status).toBe(200);
    expect(res.body.area).toEqual({ id: area.id, name: 'Soporte', color: '#ff0000' });
    expect(gateway.setStatusCalls).toHaveLength(0); // NUNCA llama a Chatwoot
    const updated = await conversationRepo.findById(conv.id);
    expect(updated!.areaId).toBe(area.id);
  });

  it('areaId: null → 200, limpia el área', async () => {
    const { app, conversationRepo, areaRepo } = buildApp();
    const area = await areaRepo.create({ name: 'Facturación', color: '#00ff00' });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 81 });
    await conversationRepo.updateLocalFields(conv.id, { areaId: area.id });

    const res = await request(app)
      .patch(`/api/messaging/conversations/${conv.id}/area`)
      .send({ areaId: null });

    expect(res.status).toBe(200);
    expect(res.body.area).toBeNull();
  });

  it('areaId ausente en el body → 400 VALIDATION_ERROR', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 82 });

    const res = await request(app).patch(`/api/messaging/conversations/${conv.id}/area`).send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('conversación inexistente → 404 CONVERSATION_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/messaging/conversations/ghost/area')
      .send({ areaId: 'area-1' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('areaId inexistente → 404 TICKET_AREA_NOT_FOUND, mirror SIN tocar', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 83 });

    const res = await request(app)
      .patch(`/api/messaging/conversations/${conv.id}/area`)
      .send({ areaId: 'ghost-area' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_AREA_NOT_FOUND');
    const stillNoArea = await conversationRepo.findById(conv.id);
    expect(stillNoArea!.areaId).toBeNull();
  });

  it('sin sesión (auth deniega) → 401', async () => {
    const { app, conversationRepo, areaRepo } = buildApp({ auth: denyAuth });
    const area = await areaRepo.create({ name: 'NOC', color: '#111111' });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 84 });

    const res = await request(app)
      .patch(`/api/messaging/conversations/${conv.id}/area`)
      .send({ areaId: area.id });

    expect(res.status).toBe(401);
  });
});

// ─── GET /assignable-users (F1.5-C2) ─────────────────────────────────────────────

describe('GET /api/messaging/assignable-users', () => {
  it('200 con el pool asignable (active + con rol + sin rol técnico)', async () => {
    const rbacUserRepo = new InMemoryRbacUserRepository();
    const active = await rbacUserRepo.create({ name: 'Ana', email: 'ana@x.com', login: 'ana', passwordHash: 'x', status: 'active' });
    const technical = await rbacUserRepo.create({ name: 'Carlos', email: 'carlos@x.com', login: 'carlos', passwordHash: 'x', status: 'active' });
    const roleLookup: UserRoleLookup = {
      listRoleCodes: async (id: string) => (id === technical.id ? ['tecnico'] : ['administrador']),
    };
    const { app } = buildApp({ rbacUserRepo, roleLookup });

    const res = await request(app).get('/api/messaging/assignable-users');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: active.id, name: 'Ana' }]);
  });

  it('nunca expone passwordHash u otro campo sensible', async () => {
    const rbacUserRepo = new InMemoryRbacUserRepository();
    await rbacUserRepo.create({ name: 'Fede', email: 'fede@x.com', login: 'fede', passwordHash: 'top-secret', status: 'active' });
    const { app } = buildApp({ rbacUserRepo, roleLookup: { listRoleCodes: async () => ['ventas'] } });

    const res = await request(app).get('/api/messaging/assignable-users');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['id', 'name']);
  });
});

// ─── GET /areas (F1.5-C2) ─────────────────────────────────────────────────────────

describe('GET /api/messaging/areas', () => {
  it('200 con el catálogo de áreas (reusa TicketAreaCatalogRepository)', async () => {
    const { app, areaRepo } = buildApp();
    await areaRepo.create({ name: 'Soporte', color: '#6366f1' });
    await areaRepo.create({ name: 'Facturación', color: '#22c55e' });

    const res = await request(app).get('/api/messaging/areas');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((a: { name: string }) => a.name).sort()).toEqual(['Facturación', 'Soporte']);
  });

  it('sin áreas → 200 con data: []', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/areas');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

// ─── GET /conversations?assignment=mine|unassigned|all (F1.5-C2) ────────────────

describe('GET /api/messaging/conversations — filtro ?assignment=', () => {
  async function seedThree(conversationRepo: InMemoryConversationRepository) {
    const mine = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 90, lastMessageAt: '2026-07-01T00:00:00.000Z' });
    const other = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 91, lastMessageAt: '2026-07-02T00:00:00.000Z' });
    const unassigned = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 92, lastMessageAt: '2026-07-03T00:00:00.000Z' });
    // allowAuth stampea req.user.id = 'user-test' — 'mine' filtra por ESE id.
    await conversationRepo.updateLocalFields(mine.id, { assigneeId: 'user-test' });
    await conversationRepo.updateLocalFields(other.id, { assigneeId: 'user-1' });
    return { mine, other, unassigned };
  }

  it("?assignment=mine → SOLO las asignadas a req.user.id (resuelto vía el middleware auth)", async () => {
    const { app, conversationRepo } = buildApp();
    const { mine } = await seedThree(conversationRepo);

    const res = await request(app).get('/api/messaging/conversations?assignment=mine');

    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { id: string }) => d.id)).toEqual([mine.id]);
  });

  it('?assignment=unassigned → SOLO las sin assigneeId', async () => {
    const { app, conversationRepo } = buildApp();
    const { unassigned } = await seedThree(conversationRepo);

    const res = await request(app).get('/api/messaging/conversations?assignment=unassigned');

    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { id: string }) => d.id)).toEqual([unassigned.id]);
  });

  it('?assignment=all (o ausente) → las 3, sin filtrar', async () => {
    const { app, conversationRepo } = buildApp();
    await seedThree(conversationRepo);

    const resAll = await request(app).get('/api/messaging/conversations?assignment=all');
    const resDefault = await request(app).get('/api/messaging/conversations');

    expect(resAll.body.data).toHaveLength(3);
    expect(resDefault.body.data).toHaveLength(3);
  });
});

// ─── GET /conversations?status=open|resolved (inbox-resolve, LS-2) ──────────────

describe('GET /api/messaging/conversations — filtro ?status=', () => {
  async function seedOpenPendingResolved(conversationRepo: InMemoryConversationRepository) {
    const open = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 950, status: 'open', lastMessageAt: '2026-07-14T00:00:00.000Z' });
    const pending = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 951, status: 'pending', lastMessageAt: '2026-07-15T00:00:00.000Z' });
    const resolved = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 952, status: 'resolved', lastMessageAt: '2026-07-16T00:00:00.000Z' });
    return { open, pending, resolved };
  }

  it('?status=open → 200 con SOLO las no-resueltas (bucket ACTIVAS, incluye pending)', async () => {
    const { app, conversationRepo } = buildApp();
    const { open, pending } = await seedOpenPendingResolved(conversationRepo);

    const res = await request(app).get('/api/messaging/conversations?status=open');

    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { id: string }) => d.id).sort()).toEqual([open.id, pending.id].sort());
  });

  it('?status=resolved → 200 con SOLO las resueltas', async () => {
    const { app, conversationRepo } = buildApp();
    const { resolved } = await seedOpenPendingResolved(conversationRepo);

    const res = await request(app).get('/api/messaging/conversations?status=resolved');

    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { id: string }) => d.id)).toEqual([resolved.id]);
  });

  it('?status=banana (valor desconocido) → 200 con TODAS, idéntico a sin param (se ignora, sin error)', async () => {
    const { app, conversationRepo } = buildApp();
    await seedOpenPendingResolved(conversationRepo);

    const res = await request(app).get('/api/messaging/conversations?status=banana');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it('combinable con ?assignment=mine: status=open&assignment=mine → no-resueltas asignadas al usuario autenticado', async () => {
    const { app, conversationRepo } = buildApp();
    const { open, pending, resolved } = await seedOpenPendingResolved(conversationRepo);
    await conversationRepo.updateLocalFields(open.id, { assigneeId: 'user-test' }); // allowAuth stampea req.user.id = 'user-test'
    await conversationRepo.updateLocalFields(pending.id, { assigneeId: 'user-1' }); // otro agente
    await conversationRepo.updateLocalFields(resolved.id, { assigneeId: 'user-test' });

    const res = await request(app).get('/api/messaging/conversations?status=open&assignment=mine');

    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { id: string }) => d.id)).toEqual([open.id]);
  });

  it('GET /conversations?status=open sin messaging:read → 403 (guard perms.read intacto)', async () => {
    const { app } = buildApp({ readPerm: denyPerm });

    const res = await request(app).get('/api/messaging/conversations?status=open');

    expect(res.status).toBe(403);
  });
});

// ─── GET /attachments/:id/file (messaging-inbox-v2-media, MEDIA-5) ──────────────

describe('GET /api/messaging/attachments/:id/file', () => {
  let nextChatwootAttachmentId = 1;

  async function seedDownloaded(
    attachmentRepo: InMemoryChatMessageAttachmentRepository,
    fileStorage: InMemoryFileStorage,
    opts: { withThumb?: boolean } = {},
  ) {
    const row = await attachmentRepo.upsertByChatwootAttachmentId({
      messageId: 'msg-1',
      chatwootAttachmentId: nextChatwootAttachmentId++,
      fileType: 'image',
      contentType: 'image/jpeg',
      filename: 'foto.jpg',
      sourceUrl: 'https://x/1.jpg',
    });
    await fileStorage.save({ key: `messaging/conv-1/${row.id}.jpg`, buffer: Buffer.from('ORIGINAL'), mimeType: 'image/jpeg' });
    if (opts.withThumb) {
      await fileStorage.save({ key: `messaging/conv-1/${row.id}-thumb.jpg`, buffer: Buffer.from('THUMB'), mimeType: 'image/jpeg' });
      await attachmentRepo.markDownloaded(row.id, {
        storageKey: `messaging/conv-1/${row.id}.jpg`,
        thumbStorageKey: `messaging/conv-1/${row.id}-thumb.jpg`,
      });
    } else {
      await attachmentRepo.markDownloaded(row.id, { storageKey: `messaging/conv-1/${row.id}.jpg` });
    }
    return row;
  }

  it('scenario 18 — sirve el original con Content-Type y Content-Disposition', async () => {
    const { app, attachmentRepo, fileStorage } = buildApp();
    const row = await seedDownloaded(attachmentRepo, fileStorage);

    const res = await request(app).get(`/api/messaging/attachments/${row.id}/file`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['content-disposition']).toContain('inline');
    expect(res.body.toString()).toBe('ORIGINAL');
  });

  it('scenario 19 — sirve el thumb con ?variant=thumb, con fallback al original si no hay thumbStorageKey', async () => {
    const { app, attachmentRepo, fileStorage } = buildApp();
    const withThumb = await seedDownloaded(attachmentRepo, fileStorage, { withThumb: true });
    const noThumb = await seedDownloaded(attachmentRepo, fileStorage);

    const resThumb = await request(app).get(`/api/messaging/attachments/${withThumb.id}/file?variant=thumb`);
    expect(resThumb.status).toBe(200);
    expect(resThumb.body.toString()).toBe('THUMB');

    const resFallback = await request(app).get(`/api/messaging/attachments/${noThumb.id}/file?variant=thumb`);
    expect(resFallback.status).toBe(200);
    expect(resFallback.body.toString()).toBe('ORIGINAL');
  });

  it('scenario 20 — status pending/failed → 409', async () => {
    const { app, attachmentRepo } = buildApp();
    const row = await attachmentRepo.upsertByChatwootAttachmentId({
      messageId: 'msg-1', chatwootAttachmentId: 2, fileType: 'file', contentType: 'application/pdf',
      sourceUrl: 'https://x/2.pdf',
    });

    const res = await request(app).get(`/api/messaging/attachments/${row.id}/file`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHAT_ATTACHMENT_NOT_READY');
  });

  it('scenario 21 — id inexistente → 404', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/attachments/ghost/file');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CHAT_ATTACHMENT_NOT_FOUND');
  });

  it('scenario 22 — sin messaging:read → 403, sin tocar el repo ni el storage', async () => {
    const { app, attachmentRepo } = buildApp({ readPerm: denyPerm });
    const spy = jest.spyOn(attachmentRepo, 'findById');
    const res = await request(app).get('/api/messaging/attachments/whatever/file');
    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('scenario 23 — el repo lanza → next(err), responde 500 inmediato (no cuelga)', async () => {
    class ThrowingAttachmentRepo extends InMemoryChatMessageAttachmentRepository {
      override async findById(): Promise<never> {
        throw new Error('db down');
      }
    }
    const { app } = buildApp({ attachmentRepo: new ThrowingAttachmentRepo() });
    const res = await request(app).get('/api/messaging/attachments/whatever/file');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('fix-be #3 (MEDIUM) — fileType "file" con content_type text/html se sirve como attachment (NO inline): previene XSS almacenado al abrirlo el agente', async () => {
    const { app, attachmentRepo, fileStorage } = buildApp();
    const row = await attachmentRepo.upsertByChatwootAttachmentId({
      messageId: 'msg-1',
      chatwootAttachmentId: 999,
      fileType: 'file', // documento arbitrario del cliente, NO clasificado como imagen/audio/video
      contentType: 'text/html',
      filename: 'factura.html',
      sourceUrl: 'https://x/evil.html',
    });
    await fileStorage.save({
      key: `messaging/conv-1/${row.id}.html`,
      buffer: Buffer.from('<script>alert(document.cookie)</script>'),
      mimeType: 'text/html',
    });
    await attachmentRepo.markDownloaded(row.id, { storageKey: `messaging/conv-1/${row.id}.html` });

    const res = await request(app).get(`/api/messaging/attachments/${row.id}/file`);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).not.toContain('inline');
  });

  it('fix-be #3 — image/audio/video SIGUEN sirviéndose inline (no regresión sobre el visor de media del inbox)', async () => {
    const { app, attachmentRepo, fileStorage } = buildApp();
    const audioRow = await attachmentRepo.upsertByChatwootAttachmentId({
      messageId: 'msg-1', chatwootAttachmentId: 998, fileType: 'audio', contentType: 'audio/ogg',
      sourceUrl: 'https://x/nota.ogg',
    });
    await fileStorage.save({ key: `messaging/conv-1/${audioRow.id}.ogg`, buffer: Buffer.from('AUDIO'), mimeType: 'audio/ogg' });
    await attachmentRepo.markDownloaded(audioRow.id, { storageKey: `messaging/conv-1/${audioRow.id}.ogg` });

    const res = await request(app).get(`/api/messaging/attachments/${audioRow.id}/file`);

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('inline');
  });
});

// ─── GET /conversations/:id/client-context (messaging-inbox-v2 F1.5, RICH-1..6) ──

describe('GET /api/messaging/conversations/:id/client-context', () => {
  function makeMatchedCustomer(overrides: Partial<Customer> & Pick<Customer, 'id' | 'name'>): Customer {
    return {
      email: 'client@test.com',
      phone: '+5492324421234',
      status: 'active',
      address: 'Calle 123',
      city: 'Rosario',
      country: 'AR',
      login: 'user',
      createdAt: '2024-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('#6 :id inexistente en el mirror → 404 CONVERSATION_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/conversations/ghost/client-context');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('#14 sin messaging:read → 403, el use case NUNCA se invoca', async () => {
    const { app, conversationRepo } = buildApp({ readPerm: denyPerm });
    const spy = jest.spyOn(conversationRepo, 'findById');
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 100 });

    const res = await request(app).get(`/api/messaging/conversations/${conv.id}/client-context`);

    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('#15 con messaging:read (sin billing/tickets:read simulados) → 200 con balance/lastInvoice/recentTickets/recentTasks completos', async () => {
    const customer = makeMatchedCustomer({
      id: 'c1',
      name: 'Juan Perez',
      balanceDue: 500,
      balanceCurrency: 'ARS',
      lastBalanceAt: '2026-07-11T09:50:00.000Z',
    });
    const customerRepo = makeCustomerRepo(
      [{ id: 'c1', name: 'Juan Perez', phone: '+5492324421234', email: null }],
      { findById: jest.fn().mockResolvedValue(customer) },
    );
    const ticketRepo = new InMemoryTicketRepository();
    await ticketRepo.create({ subject: 'Sin señal', description: 'x', customerId: 'c1' });
    const schedulingRepo = new InMemorySchedulingRepository();
    schedulingRepo.seedTask({ id: 'task-c1', title: 'Instalar equipo', customerId: 'c1' });

    const { app, conversationRepo } = buildApp({ customerRepo, ticketRepo, schedulingRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 101, contactPhone: '+5492324421234' });

    const res = await request(app).get(`/api/messaging/conversations/${conv.id}/client-context`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('matched');
    expect(res.body.client.balance.due).toBe(500);
    expect(res.body.client.recentTickets).toHaveLength(1);
    expect(res.body.client.recentTasks).toHaveLength(1);
  });

  it('#17 el repo de clientes lanza al resolver el match → responde con status de error inmediato (next(err)), nunca cuelga', async () => {
    const customerRepo = makeCustomerRepo([], { listActiveContacts: jest.fn().mockRejectedValue(new Error('db down')) });
    const { app, conversationRepo } = buildApp({ customerRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 102, contactPhone: '+5492324421234' });

    const res = await request(app).get(`/api/messaging/conversations/${conv.id}/client-context`);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('#4 (integración) ?clientId=<ajeno> sobre conversación ambigua → 400 CLIENT_ID_NOT_A_CANDIDATE', async () => {
    const customerRepo = makeCustomerRepo([
      { id: 'a', name: 'Cliente A', phone: '+5492324000000', email: null },
      { id: 'b', name: 'Cliente B', phone: '+5492324000000', email: null },
    ]);
    const { app, conversationRepo } = buildApp({ customerRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 103, contactPhone: '+5492324000000' });

    const res = await request(app).get(`/api/messaging/conversations/${conv.id}/client-context?clientId=zzz`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLIENT_ID_NOT_A_CANDIDATE');
  });

  it('#1 matched — 200 con status matched y client agregado (smoke, seam completo)', async () => {
    const customer = makeMatchedCustomer({ id: 'c1', name: 'Juan Perez' });
    const customerRepo = makeCustomerRepo(
      [{ id: 'c1', name: 'Juan Perez', phone: '+5492324421234', email: null }],
      { findById: jest.fn().mockResolvedValue(customer) },
    );
    const { app, conversationRepo } = buildApp({ customerRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 104, contactPhone: '+5492324421234' });

    const res = await request(app).get(`/api/messaging/conversations/${conv.id}/client-context`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('matched');
    expect(res.body.client.id).toBe('c1');
  });

  it('#2 ambiguous sin clientId — 200 con candidates, sin client (smoke)', async () => {
    const customerRepo = makeCustomerRepo([
      { id: 'a', name: 'Cliente A', phone: '+5492324000000', email: null },
      { id: 'b', name: 'Cliente B', phone: '+5492324000000', email: null },
    ]);
    const { app, conversationRepo } = buildApp({ customerRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 105, contactPhone: '+5492324000000' });

    const res = await request(app).get(`/api/messaging/conversations/${conv.id}/client-context`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ambiguous');
    expect(res.body.candidates).toHaveLength(2);
    expect(res.body.client).toBeUndefined();
  });

  it('#3 ambiguous con clientId válido — 200 con status matched (smoke)', async () => {
    const customerB = makeMatchedCustomer({ id: 'b', name: 'Cliente B' });
    const customerRepo = makeCustomerRepo(
      [
        { id: 'a', name: 'Cliente A', phone: '+5492324000000', email: null },
        { id: 'b', name: 'Cliente B', phone: '+5492324000000', email: null },
      ],
      { findById: jest.fn().mockResolvedValue(customerB) },
    );
    const { app, conversationRepo } = buildApp({ customerRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 106, contactPhone: '+5492324000000' });

    const res = await request(app).get(`/api/messaging/conversations/${conv.id}/client-context?clientId=b`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('matched');
    expect(res.body.client.id).toBe('b');
  });

  it('#5 unknown — 200 sin client ni candidates (smoke)', async () => {
    const { app, conversationRepo } = buildApp();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 107, contactPhone: '+5492324999999' });

    const res = await request(app).get(`/api/messaging/conversations/${conv.id}/client-context`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unknown' });
  });

  it('fix-be #7 [BAJO] clientId repetido en la query (?clientId=b&clientId=a, Express lo entrega como string[]) — normaliza al PRIMERO, no rompe la resolucion del candidato', async () => {
    const customerB = makeMatchedCustomer({ id: 'b', name: 'Cliente B' });
    const customerRepo = makeCustomerRepo(
      [
        { id: 'a', name: 'Cliente A', phone: '+5492324000000', email: null },
        { id: 'b', name: 'Cliente B', phone: '+5492324000000', email: null },
      ],
      { findById: jest.fn().mockResolvedValue(customerB) },
    );
    const { app, conversationRepo } = buildApp({ customerRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 108, contactPhone: '+5492324000000' });

    // Antes del fix: req.query.clientId llega como ['b','a'] (array), el `.some(c => c.id === chosenId)`
    // compara un string contra un array → siempre false → 400 CLIENT_ID_NOT_A_CANDIDATE aunque 'b' sea válido.
    const res = await request(app).get(`/api/messaging/conversations/${conv.id}/client-context?clientId=b&clientId=a`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('matched');
    expect(res.body.client.id).toBe('b');
  });
});

// ─── inbox-template-send (HTTP-1/HTTP-2) — enviar template desde el hilo ───────

const APPROVED_TEMPLATE: TemplateDto = {
  contentSid: 'HX1',
  friendlyName: 'Recordatorio deuda',
  language: 'es',
  variables: { '1': 'nombre', '2': 'monto' },
  approvalStatus: 'approved',
  body: 'Hola {{1}}, debés {{2}}',
};

const PENDING_TEMPLATE: TemplateDto = {
  contentSid: 'HX9',
  friendlyName: 'Pendiente',
  language: 'es',
  variables: {},
  approvalStatus: 'pending',
  body: 'Pendiente',
};

describe('POST /api/messaging/conversations/:id/send-template', () => {
  it('sin sesión (auth deniega) → 401', async () => {
    const { app } = buildApp({ auth: denyAuth, templates: [APPROVED_TEMPLATE] });

    const res = await request(app)
      .post('/api/messaging/conversations/conv-1/send-template')
      .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' } });

    expect(res.status).toBe(401);
  });

  it('sin messaging:send → 403, use case NUNCA invocado', async () => {
    const { app, templatePort } = buildApp({ sendPerm: denyPerm, templates: [APPROVED_TEMPLATE] });

    const res = await request(app)
      .post('/api/messaging/conversations/conv-1/send-template')
      .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' } });

    expect(res.status).toBe(403);
    expect(templatePort.calls).toHaveLength(0);
  });

  it('con messaging:read pero NO messaging:send → 403 (mismo permiso que el envío actual)', async () => {
    const { app } = buildApp({ readPerm: allowPerm, sendPerm: denyPerm, templates: [APPROVED_TEMPLATE] });

    const res = await request(app)
      .post('/api/messaging/conversations/conv-1/send-template')
      .send({ templateRef: 'HX1', variables: {} });

    expect(res.status).toBe(403);
  });

  it('body vacío {} → 400 VALIDATION_ERROR, use case NUNCA invocado', async () => {
    const { app, templatePort } = buildApp({ templates: [APPROVED_TEMPLATE] });

    const res = await request(app).post('/api/messaging/conversations/conv-1/send-template').send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(templatePort.calls).toHaveLength(0);
  });

  it('templateRef no-string (número) → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp({ templates: [APPROVED_TEMPLATE] });

    const res = await request(app)
      .post('/api/messaging/conversations/conv-1/send-template')
      .send({ templateRef: 42 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('variables con un valor no-string → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp({ templates: [APPROVED_TEMPLATE] });

    const res = await request(app)
      .post('/api/messaging/conversations/conv-1/send-template')
      .send({ templateRef: 'HX1', variables: { '1': 7 } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('conversación inexistente → 404 CONVERSATION_NOT_FOUND', async () => {
    const { app } = buildApp({ templates: [APPROVED_TEMPLATE] });

    const res = await request(app)
      .post('/api/messaging/conversations/ghost/send-template')
      .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' } });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
  });

  it('conversación sin teléfono → 422 CONVERSATION_PHONE_MISSING', async () => {
    const { app, conversationRepo } = buildApp({ templates: [APPROVED_TEMPLATE] });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 200 });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/send-template`)
      .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' } });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CONVERSATION_PHONE_MISSING');
  });

  it('template pending → 422 TEMPLATE_NOT_APPROVED', async () => {
    const { app, conversationRepo } = buildApp({ templates: [APPROVED_TEMPLATE, PENDING_TEMPLATE] });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 201, contactPhone: '+5491123456789' });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/send-template`)
      .send({ templateRef: 'HX9', variables: {} });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TEMPLATE_NOT_APPROVED');
  });

  it('variable faltante → 422 MISSING_TEMPLATE_VARIABLES con missing[]', async () => {
    const { app, conversationRepo } = buildApp({ templates: [APPROVED_TEMPLATE] });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 202, contactPhone: '+5491123456789' });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/send-template`)
      .send({ templateRef: 'HX1', variables: { '1': 'Juan' } });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MISSING_TEMPLATE_VARIABLES');
    expect(res.body.missing).toEqual(['2']);
  });

  it('proveedor rechaza (4xx per-mensaje) → 422 TEMPLATE_SEND_REJECTED', async () => {
    const templatePort = new InMemoryTemplateMessagingGateway({
      templates: [APPROVED_TEMPLATE],
      rejectPhone: '+5491123456789',
    });
    const { app, conversationRepo } = buildApp({ templatePort });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 203, contactPhone: '+5491123456789' });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/send-template`)
      .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' } });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TEMPLATE_SEND_REJECTED');
  });

  it('proveedor caído → 503 TEMPLATE_PROVIDER_UNAVAILABLE', async () => {
    const templatePort = new InMemoryTemplateMessagingGateway({
      templates: [APPROVED_TEMPLATE],
      failNthWith429: 1,
    });
    const { app, conversationRepo } = buildApp({ templatePort });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 204, contactPhone: '+5491123456789' });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/send-template`)
      .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' } });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('TEMPLATE_PROVIDER_UNAVAILABLE');
  });

  it('201 happy path — DTO flat outbound, visible por GET .../messages, preview bumpeado, composer sigue bloqueado (canReply intacto)', async () => {
    const { app, conversationRepo } = buildApp({
      templates: [APPROVED_TEMPLATE],
      auth: (req: Request, _res: Response, next: NextFunction) => {
        (req as any).user = { id: 'user-test', username: 'agente1', email: 'test@test.com' };
        next();
      },
    });
    const conv = await conversationRepo.upsertByChatwootId({
      chatwootConversationId: 205,
      contactPhone: '+5491123456789',
      canReply: false,
    });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/send-template`)
      .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' } });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({
        direction: 'outbound',
        content: 'Hola Juan, debés $5.000',
        senderName: 'agente1',
      }),
    );

    const messagesRes = await request(app).get(`/api/messaging/conversations/${conv.id}/messages`);
    expect(messagesRes.body.data).toHaveLength(1);
    expect(messagesRes.body.data[0].content).toBe('Hola Juan, debés $5.000');

    const updatedConv = await conversationRepo.findById(conv.id);
    expect(updatedConv!.lastMessagePreview).toBe('Hola Juan, debés $5.000');
    // D2 — el template NUNCA abre la ventana: canReply sigue false.
    expect(updatedConv!.canReply).toBe(false);
  });

  describe('H1 (fix wave, ALTO) — idempotencyKey server-side', () => {
    it('mismo idempotencyKey dos veces → 201 en el primero, 200 en el segundo (sin re-enviar), MISMO body, UNA sola fila en el hilo', async () => {
      const { app, conversationRepo, templatePort } = buildApp({ templates: [APPROVED_TEMPLATE] });
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 207, contactPhone: '+5491123456789' });

      const first = await request(app)
        .post(`/api/messaging/conversations/${conv.id}/send-template`)
        .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' }, idempotencyKey: 'idem-http-1' });

      expect(first.status).toBe(201);

      const second = await request(app)
        .post(`/api/messaging/conversations/${conv.id}/send-template`)
        .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' }, idempotencyKey: 'idem-http-1' });

      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(templatePort.calls).toHaveLength(1);

      const messagesRes = await request(app).get(`/api/messaging/conversations/${conv.id}/messages`);
      expect(messagesRes.body.data).toHaveLength(1);
    });

    it('distinto idempotencyKey → dos envíos 201 independientes, dos filas', async () => {
      const { app, conversationRepo, templatePort } = buildApp({ templates: [APPROVED_TEMPLATE] });
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 208, contactPhone: '+5491123456789' });

      const first = await request(app)
        .post(`/api/messaging/conversations/${conv.id}/send-template`)
        .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' }, idempotencyKey: 'idem-http-A' });
      const second = await request(app)
        .post(`/api/messaging/conversations/${conv.id}/send-template`)
        .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' }, idempotencyKey: 'idem-http-B' });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(templatePort.calls).toHaveLength(2);

      const messagesRes = await request(app).get(`/api/messaging/conversations/${conv.id}/messages`);
      expect(messagesRes.body.data).toHaveLength(2);
    });

    it('idempotencyKey ausente → comportamiento actual, 201 siempre (sin dedup, FE viejo)', async () => {
      const { app, conversationRepo, templatePort } = buildApp({ templates: [APPROVED_TEMPLATE] });
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 209, contactPhone: '+5491123456789' });

      const first = await request(app)
        .post(`/api/messaging/conversations/${conv.id}/send-template`)
        .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' } });
      const second = await request(app)
        .post(`/api/messaging/conversations/${conv.id}/send-template`)
        .send({ templateRef: 'HX1', variables: { '1': 'Juan', '2': '$5.000' } });

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(templatePort.calls).toHaveLength(2);
    });

    it('idempotencyKey no-string → 400 VALIDATION_ERROR, use case NUNCA invocado', async () => {
      const { app, templatePort } = buildApp({ templates: [APPROVED_TEMPLATE] });

      const res = await request(app)
        .post('/api/messaging/conversations/conv-1/send-template')
        .send({ templateRef: 'HX1', variables: {}, idempotencyKey: 42 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(templatePort.calls).toHaveLength(0);
    });

    it('idempotencyKey string vacío → 400 VALIDATION_ERROR', async () => {
      const { app } = buildApp({ templates: [APPROVED_TEMPLATE] });

      const res = await request(app)
        .post('/api/messaging/conversations/conv-1/send-template')
        .send({ templateRef: 'HX1', variables: {}, idempotencyKey: '' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  it('variables ausente → trata como {} (template sin variables declaradas se envía directo)', async () => {
    const noVarTemplate: TemplateDto = {
      contentSid: 'HX2',
      friendlyName: 'Sin variables',
      language: 'es',
      variables: {},
      approvalStatus: 'approved',
      body: 'Hola, este es un mensaje fijo.',
    };
    const { app, conversationRepo } = buildApp({ templates: [noVarTemplate] });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 206, contactPhone: '+5491123456789' });

    const res = await request(app)
      .post(`/api/messaging/conversations/${conv.id}/send-template`)
      .send({ templateRef: 'HX2' });

    expect(res.status).toBe(201);
    expect(res.body.content).toBe('Hola, este es un mensaje fijo.');
  });
});

describe('GET /api/messaging/send-templates', () => {
  it('sin sesión → 401', async () => {
    const { app } = buildApp({ auth: denyAuth });

    const res = await request(app).get('/api/messaging/send-templates');

    expect(res.status).toBe(401);
  });

  it('sin messaging:send → 403', async () => {
    const { app } = buildApp({ sendPerm: denyPerm });

    const res = await request(app).get('/api/messaging/send-templates');

    expect(res.status).toBe(403);
  });

  it('200 con el catálogo completo curado (approved Y pending, sendable correcto por item)', async () => {
    const { app } = buildApp({ templates: [APPROVED_TEMPLATE, PENDING_TEMPLATE] });

    const res = await request(app).get('/api/messaging/send-templates');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const approved = res.body.data.find((t: { contentSid: string }) => t.contentSid === 'HX1');
    const pending = res.body.data.find((t: { contentSid: string }) => t.contentSid === 'HX9');
    expect(approved.sendable).toBe(true);
    expect(pending.sendable).toBe(false);
  });
});

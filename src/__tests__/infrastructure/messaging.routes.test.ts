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
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { ReceiveChatwootWebhook } from '../../application/use-cases/messaging/ReceiveChatwootWebhook';
import { ListConversations } from '../../application/use-cases/messaging/ListConversations';
import { GetConversation } from '../../application/use-cases/messaging/GetConversation';
import { ListMessages } from '../../application/use-cases/messaging/ListMessages';
import { SendMessage } from '../../application/use-cases/messaging/SendMessage';
import { GetClientContextByPhone } from '../../application/use-cases/messaging/GetClientContextByPhone';
import { GetInboxClientContext } from '../../application/use-cases/messaging/GetInboxClientContext';
import { GetClientContracts } from '../../application/use-cases/GetClientContracts';
import { GetClientInvoices } from '../../application/use-cases/GetClientInvoices';
import { GetClientLogs } from '../../application/use-cases/GetClientLogs';
import { ListTickets } from '../../application/use-cases/ListTickets';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { ListPppoeByContract } from '../../application/use-cases/ListPppoeByContract';
import { InMemoryConversationRepository } from '../../infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '../../infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryWebhookDeliveryRepository } from '../../infrastructure/adapters/in-memory/InMemoryWebhookDeliveryRepository';
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryPppoeServiceRepository } from '../../infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { FakeChatwootGateway } from '../helpers/FakeChatwootGateway';
import type { CustomerRepository, ActiveClientContact } from '../../domain/ports/CustomerRepository';
import type { Customer } from '../../domain/entities/customer';
import { config } from '../../infrastructure/config';

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
  gateway?: FakeChatwootGateway;
  customerContacts?: ActiveClientContact[];
  /** messaging-inbox-v2 (F1.5, B4) — full CustomerRepository override for
   * client-context tests that need `findById`/`listContracts`/etc, not just
   * `listActiveContacts`. Takes precedence over `customerContacts`. */
  customerRepo?: CustomerRepository;
  ticketRepo?: InMemoryTicketRepository;
  schedulingRepo?: InMemorySchedulingRepository;
  pppoeRepo?: InMemoryPppoeServiceRepository;
}

function buildApp(opts: BuildAppOptions = {}) {
  mockConfig.chatwoot.webhookSecret = WEBHOOK_SECRET;

  const conversationRepo = opts.conversationRepo ?? new InMemoryConversationRepository();
  const messageRepo = opts.messageRepo ?? new InMemoryChatMessageRepository();
  const deliveryRepo = opts.deliveryRepo ?? new InMemoryWebhookDeliveryRepository();
  const gateway = opts.gateway ?? new FakeChatwootGateway();
  const customerRepo = opts.customerRepo ?? makeCustomerRepo(opts.customerContacts);
  const ticketRepo = opts.ticketRepo ?? new InMemoryTicketRepository();
  const schedulingRepo = opts.schedulingRepo ?? new InMemorySchedulingRepository();
  const pppoeRepo = opts.pppoeRepo ?? new InMemoryPppoeServiceRepository();
  const getClientContext = new GetClientContextByPhone(customerRepo);
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
      new ReceiveChatwootWebhook(conversationRepo, messageRepo, deliveryRepo),
      new ListConversations(conversationRepo),
      new GetConversation(conversationRepo, messageRepo, gateway, getClientContext),
      new ListMessages(conversationRepo, messageRepo),
      new SendMessage(conversationRepo, messageRepo, gateway),
      getInboxClientContext,
      createChatwootSignatureMiddleware({ now: () => NOW_MS }),
      opts.auth ?? allowAuth,
      perms,
    ),
  );
  app.use(errorHandler);

  return { app, conversationRepo, messageRepo, deliveryRepo, gateway, customerRepo, ticketRepo, schedulingRepo, pppoeRepo };
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

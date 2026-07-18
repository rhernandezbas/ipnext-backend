/**
 * conversation-events (Ola 2) — /api/messaging/reports route tests. Seam completo: use cases
 * REALES + adapters in-memory + errorHandler REAL, con auth/perm stubs (mismo idioma que
 * messaging.routes.test.ts).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  createMessagingReportsRouter,
  MessagingReportsRoutePerms,
} from '../../infrastructure/http/routes/messagingReports.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { GetReportsOverview } from '../../application/use-cases/messaging/GetReportsOverview';
import { GetTrafficReport } from '../../application/use-cases/messaging/GetTrafficReport';
import { GetResolutionsReport } from '../../application/use-cases/messaging/GetResolutionsReport';
import { GetInboxViewCounts } from '../../application/use-cases/messaging/GetInboxViewCounts';
import { InMemoryConversationRepository } from '../../infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '../../infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryConversationEventRepository } from '../../infrastructure/adapters/in-memory/InMemoryConversationEventRepository';

const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as unknown as { user: unknown }).user = { id: 'user-test' };
  next();
};
const denyAuth: RequestHandler = (_req, res) => {
  res.status(401).json({ error: 'UNAUTHORIZED', code: 'NO_USER_CONTEXT' });
};
const denyPerm: RequestHandler = (_req, res) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};
const allowPerm: RequestHandler = (_req, _res, next) => next();

interface Opts {
  auth?: RequestHandler;
  readPerm?: RequestHandler;
}

let seq = 0;

async function buildApp(opts: Opts = {}) {
  const conversationRepo = new InMemoryConversationRepository();
  const eventRepo = new InMemoryConversationEventRepository();
  const messageRepo = new InMemoryChatMessageRepository();

  // 2 open + 1 pending + 1 resolved.
  const o1 = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1, status: 'open' });
  conversationRepo.syncLastPublicMessageDirection(o1.id, 'inbound'); // unattended
  await conversationRepo.upsertByChatwootId({ chatwootConversationId: 2, status: 'open' });
  await conversationRepo.upsertByChatwootId({ chatwootConversationId: 3, status: 'pending' });
  await conversationRepo.upsertByChatwootId({ chatwootConversationId: 4, status: 'resolved' });

  eventRepo.seed([
    { conversationId: 'c', type: 'resolved', createdAt: '2026-07-15T12:00:00.000Z' },
    { conversationId: 'c', type: 'resolved', createdAt: '2026-07-16T12:00:00.000Z' },
  ]);

  await messageRepo.upsertByChatwootMessageId({
    conversationId: o1.id,
    chatwootMessageId: ++seq,
    direction: 'inbound',
    content: 'hola',
    chatwootCreatedAt: '2026-07-15T12:00:00.000Z', // AR miércoles 09h
  });

  const perms: MessagingReportsRoutePerms = { read: opts.readPerm ?? allowPerm };

  const app = express();
  app.use(express.json());
  app.use(
    '/api/messaging/reports',
    createMessagingReportsRouter(
      new GetReportsOverview(conversationRepo, eventRepo, new GetInboxViewCounts(conversationRepo)),
      new GetTrafficReport(messageRepo),
      new GetResolutionsReport(eventRepo),
      opts.auth ?? allowAuth,
      perms,
    ),
  );
  app.use(errorHandler);
  return { app };
}

const RANGE = 'from=2020-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z';

describe('/api/messaging/reports — RBAC', () => {
  it('GET /overview sin messaging:read → 403', async () => {
    const { app } = await buildApp({ readPerm: denyPerm });
    expect((await request(app).get(`/api/messaging/reports/overview?${RANGE}`)).status).toBe(403);
  });

  it('GET /traffic sin auth → 401', async () => {
    const { app } = await buildApp({ auth: denyAuth });
    expect((await request(app).get(`/api/messaging/reports/traffic?${RANGE}`)).status).toBe(401);
  });
});

describe('GET /api/messaging/reports/overview', () => {
  it('devuelve el contrato completo, coherente con el estado actual', async () => {
    const { app } = await buildApp();
    const res = await request(app).get(`/api/messaging/reports/overview?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      resolvedInRange: 2,
      createdInRange: 4,
      currentOpen: 3,
      currentUnattended: 1,
      currentUnassigned: 3, // open1 + open2 + pending, todas sin assignee
      currentPending: 1,
    });
  });

  it('from/to faltantes → 400 VALIDATION_ERROR', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/messaging/reports/overview');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('from/to no parseable → 400', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/messaging/reports/overview?from=nope&to=2100-01-01');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/messaging/reports/traffic', () => {
  it('devuelve celdas dow×hour en zona AR', async () => {
    const { app } = await buildApp();
    const res = await request(app).get(`/api/messaging/reports/traffic?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe('America/Argentina/Buenos_Aires');
    expect(res.body.cells).toEqual([{ dow: 3, hour: 9, count: 1 }]);
  });
});

describe('GET /api/messaging/reports/resolutions', () => {
  it('devuelve resoluciones por día', async () => {
    const { app } = await buildApp();
    const res = await request(app).get(`/api/messaging/reports/resolutions?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.days).toEqual([
      { date: '2026-07-15', count: 1 },
      { date: '2026-07-16', count: 1 },
    ]);
  });

  it('rango vacío → días vacíos', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/messaging/reports/resolutions?from=2000-01-01&to=2001-01-01');
    expect(res.status).toBe(200);
    expect(res.body.days).toEqual([]);
  });
});

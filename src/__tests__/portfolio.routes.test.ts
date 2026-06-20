/**
 * Route integration tests for /api/portfolio.
 * Uses real GetMyPortfolio with in-memory adapters — no Prisma.
 * Auth is bypassed with an allowAuth middleware that stamps req.user.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { createPortfolioRouter } from '../infrastructure/http/routes/portfolio.routes';
import { GetMyPortfolio } from '../application/use-cases/portfolio/GetMyPortfolio';
import { InMemoryRbacUserRepository } from '../infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryPortfolioReadRepository } from '../infrastructure/adapters/in-memory/InMemoryPortfolioReadRepository';
import { InMemoryTicketRepository } from '../infrastructure/adapters/in-memory/InMemoryTicketRepository';

// ─── Auth + RBAC mock helpers ─────────────────────────────────────────────────

const USER_ID = 'user-test';

/** Always-pass auth middleware: stamps req.user = { id: USER_ID } */
const allowAuth = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: USER_ID, email: 'test@test.com' };
  next();
};

/** Always-reject RBAC guard (403) */
const denyPerm: RequestHandler = (_req, res, _next) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};

/** Always-pass RBAC guard */
const allowPerm: RequestHandler = (_req, _res, next) => next();

interface BuildAppOptions {
  readPerm?: RequestHandler;
  vendedor?: string | null;
  seedPortfolio?: (repo: InMemoryPortfolioReadRepository) => void;
}

async function buildApp(opts: BuildAppOptions = {}) {
  const rbac = new InMemoryRbacUserRepository();
  const portfolio = new InMemoryPortfolioReadRepository();
  const tickets = new InMemoryTicketRepository();

  // Wire the logged-in user (USER_ID) with the requested vendedor mapping.
  const user = await rbac.create({ name: 'Agent', email: 'a@test.com', login: 'agent', passwordHash: 'x' });
  // Re-key the store so findById(USER_ID) resolves — the route stamps USER_ID.
  // Simplest path: create with a known id is not supported, so we map via update
  // and then look up by the generated id. Instead, override findById via a thin proxy.
  if (opts.vendedor !== undefined) {
    await rbac.update(user.id, { grVendedorName: opts.vendedor });
  }
  // Proxy: route reads USER_ID; redirect that to the created user's id.
  const rbacProxy = {
    findById: (id: string) => rbac.findById(id === USER_ID ? user.id : id),
  } as unknown as InMemoryRbacUserRepository;

  if (opts.seedPortfolio) opts.seedPortfolio(portfolio);

  const getMyPortfolio = new GetMyPortfolio(rbacProxy, portfolio, tickets);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(
    '/api/portfolio',
    createPortfolioRouter(getMyPortfolio, allowAuth, {
      read: opts.readPerm ?? allowPerm,
    }),
  );

  return { app };
}

describe('GET /api/portfolio/mine — RBAC', () => {
  it('returns 403 when read perm denied', async () => {
    const { app } = await buildApp({ readPerm: denyPerm, vendedor: 'V' });
    const res = await request(app).get('/api/portfolio/mine').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(403);
  });
});

describe('GET /api/portfolio/mine — unmapped', () => {
  it('returns 200 with unmapped shape when the agent has no vendedor', async () => {
    const { app } = await buildApp({ vendedor: null });
    const res = await request(app).get('/api/portfolio/mine').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.unmapped).toBe(true);
    expect(res.body.items).toEqual([]);
    expect(res.body.summary.total).toBe(0);
  });
});

describe('GET /api/portfolio/mine — mapped', () => {
  it('returns 200 with items + summary when the agent is mapped', async () => {
    const { app } = await buildApp({
      vendedor: 'V',
      seedPortfolio: (repo) => {
        repo.seed({ clientId: 'c1', clientName: 'Alice', status: 'active', balanceDue: 100, balanceCurrency: 'ARS', vendedor: 'V', startDate: '2026-05-01T00:00:00.000Z' });
        repo.seed({ clientId: 'c2', clientName: 'Bob', status: 'late', balanceDue: null, balanceCurrency: null, vendedor: 'V', startDate: '2025-01-01T00:00:00.000Z' });
      },
    });
    const res = await request(app).get('/api/portfolio/mine').set('Cookie', 'auth_token=tok');
    expect(res.status).toBe(200);
    expect(res.body.unmapped).toBe(false);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.summary.total).toBe(2);
    expect(res.body.summary.withDebt).toBe(2); // c1 balance>0, c2 late
    const item = res.body.items.find((i: { clientId: string }) => i.clientId === 'c1');
    expect(item).toMatchObject({
      clientId: 'c1',
      clientName: 'Alice',
      status: 'active',
      hasDebt: true,
      debtAmount: 100,
      debtCurrency: 'ARS',
      contractsCount: 1,
      openClaims: 0,
    });
    expect(item).toHaveProperty('ageBucket');
    expect(item).toHaveProperty('oldestStartDate');
  });
});

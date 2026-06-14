/**
 * Route tests for /api/admin/iclass/statuses/* endpoints.
 * Uses in-memory repos. Exercises the real errorHandler.
 *
 * Covers:
 * - GET  /statuses             → 200 { items } (gate: iclass.read) / 403 without
 * - POST /statuses/sync        → 200 { synced, created, updated } (gate: iclass.manage)
 * - PATCH /statuses/:code      → 200 updated entry / 404 not found / 400 bad body
 * - 502 when IClass unavailable during sync
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryIClassStatusCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassStatusCatalogRepository';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { SyncIClassStatuses } from '@application/use-cases/SyncIClassStatuses';
import { ListIClassStatusCatalog } from '@application/use-cases/ListIClassStatusCatalog';
import { UpdateIClassStatusCatalog } from '@application/use-cases/UpdateIClassStatusCatalog';
import { createIClassStatusesRouter } from '@infrastructure/http/routes/iclassStatuses.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { User } from '@domain/entities/auth';
import { AuthProvider } from '@domain/ports/AuthProvider';

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'a', username: 'u', email: 'e@e.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_t: string): Promise<User> {
    return { id: 'a', username: 'u', email: 'e@e.com', role: 'admin' };
  }
}

/** Pass-through permission middleware (grants all) */
const ALLOW: RequestHandler = (_req, _res, next) => next();
/** Deny permission middleware (simulates missing permission) */
const DENY: RequestHandler = (_req: Request, res: Response, _next: NextFunction): void => {
  res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
};

function buildApp(opts: {
  iclassFails?: boolean;
  requireRead?: RequestHandler;
  requireManage?: RequestHandler;
} = {}) {
  const catalogRepo = new InMemoryIClassStatusCatalogRepository();
  const iclass = new InMemoryIClassClient();
  if (opts.iclassFails) iclass.failureMode = 'unavailable';

  const syncUC = new SyncIClassStatuses(iclass, catalogRepo);
  const listUC = new ListIClassStatusCatalog(catalogRepo);
  const updateUC = new UpdateIClassStatusCatalog(catalogRepo);

  const requireRead = opts.requireRead ?? ALLOW;
  const requireManage = opts.requireManage ?? ALLOW;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/admin/iclass',
    createIClassStatusesRouter(syncUC, listUC, updateUC, new FakeAuthProvider(), requireRead, requireManage),
  );
  app.use(errorHandler);

  return { app, catalogRepo, iclass };
}

// ─── GET /api/admin/iclass/statuses ──────────────────────────────────────────

describe('GET /api/admin/iclass/statuses', () => {
  it('returns 200 with items when catalog has entries', async () => {
    const { app, catalogRepo } = buildApp();
    await catalogRepo.upsertByStatusCode({ statusCode: '3', iclassLabel: 'Agendada' });
    await catalogRepo.upsertByStatusCode({ statusCode: '7', iclassLabel: 'Concluida' });
    await catalogRepo.update('7', { displayLabel: 'Cerrada', color: '#00FF00', tracked: true });

    const res = await request(app)
      .get('/api/admin/iclass/statuses')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(2);

    const item7 = res.body.items.find((i: { statusCode: string }) => i.statusCode === '7');
    expect(item7).toBeDefined();
    expect(item7.effectiveLabel).toBe('Cerrada');
    expect(item7.color).toBe('#00FF00');
    expect(item7.tracked).toBe(true);

    const item3 = res.body.items.find((i: { statusCode: string }) => i.statusCode === '3');
    expect(item3.effectiveLabel).toBe('Agendada'); // displayLabel=null → iclassLabel
    expect(typeof item3.lastSyncedAt).toBe('string'); // ISO 8601
  });

  it('returns 200 with empty items when catalog is empty', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get('/api/admin/iclass/statuses')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('returns 403 when user lacks iclass.read permission', async () => {
    const { app } = buildApp({ requireRead: DENY });
    const res = await request(app)
      .get('/api/admin/iclass/statuses')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(403);
  });
});

// ─── POST /api/admin/iclass/statuses/sync ────────────────────────────────────

describe('POST /api/admin/iclass/statuses/sync', () => {
  it('returns 200 with created/updated counts', async () => {
    const { app, iclass } = buildApp();
    iclass.serviceOrders = [
      { iclassId: '1', iclassCodigo: '1001', clusterName: 'X', thirdPartyCode: null, nodeCode: null, soTypeId: null, soTypeDescription: null,
        customerCode: 'c', customerName: 'N', addressCode: 'a', addressLine: 'A', addressCity: 'C',
        addressLat: null, addressLng: null, statusCode: '3', statusDescription: 'Agendada',
        requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
        resultCodeName: null, closedByLogin: null, closedByName: null,
        closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: 0,
        technicianNote: null, internalNote: null, commentaryLog: null,
        teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
        iclassCreatedAt: null, iclassUpdatedAt: null, rawDetail: {} },
    ];

    const res = await request(app)
      .post('/api/admin/iclass/statuses/sync')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);
    expect(res.body.created).toBe(1);
    expect(res.body.updated).toBe(0);
  });

  it('returns 502 when IClass is unavailable', async () => {
    const { app } = buildApp({ iclassFails: true });
    const res = await request(app)
      .post('/api/admin/iclass/statuses/sync')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ICLASS_UNAVAILABLE');
  });

  it('returns 403 when user lacks iclass.manage permission', async () => {
    const { app } = buildApp({ requireManage: DENY });
    const res = await request(app)
      .post('/api/admin/iclass/statuses/sync')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(403);
  });
});

// ─── PATCH /api/admin/iclass/statuses/:statusCode ─────────────────────────────

describe('PATCH /api/admin/iclass/statuses/:statusCode', () => {
  it('200 — updates tracked', async () => {
    const { app, catalogRepo } = buildApp();
    await catalogRepo.upsertByStatusCode({ statusCode: '12', iclassLabel: 'Em Análise' });

    const res = await request(app)
      .patch('/api/admin/iclass/statuses/12')
      .set('Cookie', 'auth_token=fake')
      .send({ tracked: true });

    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe('12');
    expect(res.body.tracked).toBe(true);
    expect(res.body.effectiveLabel).toBe('Em Análise');
  });

  it('200 — updates displayLabel and color', async () => {
    const { app, catalogRepo } = buildApp();
    await catalogRepo.upsertByStatusCode({ statusCode: '12', iclassLabel: 'Em Análise' });

    const res = await request(app)
      .patch('/api/admin/iclass/statuses/12')
      .set('Cookie', 'auth_token=fake')
      .send({ displayLabel: 'En análisis', color: '#FFAA00' });

    expect(res.status).toBe(200);
    expect(res.body.displayLabel).toBe('En análisis');
    expect(res.body.color).toBe('#FFAA00');
    expect(res.body.effectiveLabel).toBe('En análisis');
  });

  it('404 — unknown statusCode', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/admin/iclass/statuses/999')
      .set('Cookie', 'auth_token=fake')
      .send({ tracked: true });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ICLASS_STATUS_NOT_FOUND');
  });

  it('400 — invalid color (not hex format)', async () => {
    const { app, catalogRepo } = buildApp();
    await catalogRepo.upsertByStatusCode({ statusCode: '12', iclassLabel: 'Em Análise' });

    const res = await request(app)
      .patch('/api/admin/iclass/statuses/12')
      .set('Cookie', 'auth_token=fake')
      .send({ color: 'red' }); // not #RRGGBB

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('403 — without iclass.manage permission', async () => {
    const { app, catalogRepo } = buildApp({ requireManage: DENY });
    await catalogRepo.upsertByStatusCode({ statusCode: '12', iclassLabel: 'Em Análise' });

    const res = await request(app)
      .patch('/api/admin/iclass/statuses/12')
      .set('Cookie', 'auth_token=fake')
      .send({ tracked: true });

    expect(res.status).toBe(403);
  });
});

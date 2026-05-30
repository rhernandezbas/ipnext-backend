/**
 * auditEvents.routes.test.ts — GET /api/admin/audit-events (SDD #4 Phase 3).
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryAuditEventRepository } from '@infrastructure/adapters/in-memory/InMemoryAuditEventRepository';
import { ListAuditEvents } from '@application/use-cases/audit/ListAuditEvents';
import { createAuditEventsRouter } from '@infrastructure/http/routes/auditEvents.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';

function buildApp(opts: { allow?: boolean } = {}) {
  const { allow = true } = opts;
  const app = express();
  app.use(express.json());

  const repo = new InMemoryAuditEventRepository();
  repo.seed({ actorId: 'u1', actorLogin: 'ana', method: 'POST', entityType: 'RbacUser', createdAt: '2026-05-10T10:00:00.000Z' });
  repo.seed({ actorId: 'u2', actorLogin: 'beto', method: 'DELETE', entityType: 'RbacRole', createdAt: '2026-05-20T10:00:00.000Z' });
  repo.seed({ actorId: 'u1', actorLogin: 'ana', method: 'PATCH', entityType: 'ScheduledTask', createdAt: '2026-05-29T10:00:00.000Z' });

  const guard = allow
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : (_req: Request, res: Response) => { res.status(403).json({ code: 'FORBIDDEN' }); };

  app.use('/api/admin/audit-events', guard, createAuditEventsRouter(new ListAuditEvents(repo)));
  app.use(errorHandler);
  return { app };
}

describe('GET /api/admin/audit-events', () => {
  it('returns a paginated page of events (newest first)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/audit-events?page=1&pageSize=2');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].createdAt).toBe('2026-05-29T10:00:00.000Z');
  });

  it('filters by method', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/audit-events?method=DELETE');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].method).toBe('DELETE');
  });

  it('returns 403 when the guard denies', async () => {
    const { app } = buildApp({ allow: false });
    const res = await request(app).get('/api/admin/audit-events');
    expect(res.status).toBe(403);
  });

  it('returns 400 on a malformed date filter', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/audit-events?from=not-a-date');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

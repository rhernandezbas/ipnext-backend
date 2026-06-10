/**
 * Integration tests for the gr-sync admin router.
 * Covers the reset-clients-cursor endpoint (auth + backfill trigger).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { InMemorySyncStateRepository } from '../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { ResetGrClientsCursor } from '../../application/use-cases/ResetGrClientsCursor';
import { ReconcileGrClients } from '../../application/use-cases/ReconcileGrClients';
import { InMemoryGestionRealPort } from '../../infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorReadRepository } from '../../infrastructure/adapters/in-memory/InMemoryClientMirrorReadRepository';
import { createGrSyncRouter } from '../../infrastructure/http/routes/gr-sync.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import type { AuthProvider } from '../../domain/ports/AuthProvider';
import type { GrClient } from '../../domain/entities/gestionReal';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const stateRepo = new InMemorySyncStateRepository();
  const resetUC = new ResetGrClientsCursor(stateRepo);

  const authProvider = {
    getSession: jest.fn().mockResolvedValue({ id: '1', email: 'admin@test.com', role: 'admin' }),
  } as unknown as AuthProvider;

  app.use('/api/admin/gr-sync', createGrSyncRouter(authProvider, resetUC));
  app.use(errorHandler);

  return { app, stateRepo };
}

function grClient(id: string, statusCode: string | null = '1'): GrClient {
  return {
    grClienteId: id,
    name: `Client ${id}`,
    documento: null,
    email: null,
    phone: null,
    status: null,
    statusCode,
    address: null,
    city: null,
    province: null,
    ultimaModificacion: null,
    fechaCreacion: null,
    raw: {},
  };
}

/** Build an app whose gr-sync router has a ReconcileGrClients wired in. */
function buildAppWithReconcile(grIds: string[], localIds: string[]) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const stateRepo = new InMemorySyncStateRepository();
  const resetUC = new ResetGrClientsCursor(stateRepo);

  const gr = new InMemoryGestionRealPort();
  gr.clients = grIds.map(id => grClient(id));
  const mirror = new InMemoryClientMirrorReadRepository(localIds);
  const reconcileUC = new ReconcileGrClients(gr, mirror);

  const authProvider = {
    getSession: jest.fn().mockResolvedValue({ id: '1', email: 'admin@test.com', role: 'admin' }),
  } as unknown as AuthProvider;

  app.use('/api/admin/gr-sync', createGrSyncRouter(authProvider, resetUC, reconcileUC));
  app.use(errorHandler);

  return { app };
}

function withAuth(req: request.Test) {
  return req.set('Cookie', 'auth_token=mock-token');
}

describe('POST /api/admin/gr-sync/reset-clients-cursor', () => {
  it('resets the cursor and returns 200 with the backfill message', async () => {
    const { app, stateRepo } = buildApp();
    await stateRepo.save({
      entity: 'gr-clients',
      cursor: '25-05-2026',
      lastRunAt: new Date('2026-05-25T10:00:00Z'),
      lastResult: 'ok',
      itemsSynced: 100,
    });

    const res = await withAuth(request(app).post('/api/admin/gr-sync/reset-clients-cursor'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      entity: 'gr-clients',
      cursor: null,
      message: 'next sync will backfill all clients',
    });
    expect((await stateRepo.get('gr-clients'))?.cursor).toBeNull();
  });

  it('returns 401 without auth', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/admin/gr-sync/reset-clients-cursor');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/gr-sync/reconcile-report', () => {
  it('returns 200 with the reconcile report shape (REQ-REC-ENDPOINT-1)', async () => {
    // GR {A,B,C,Z}, local {A,B,C,X} → grOnly=[Z], localOnly=[X]
    const { app } = buildAppWithReconcile(['A', 'B', 'C', 'Z'], ['A', 'B', 'C', 'X']);

    const res = await withAuth(request(app).post('/api/admin/gr-sync/reconcile-report'));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['grOnly', 'grOnlyCount', 'grTotal', 'localOnly', 'localOnlyCount', 'localTotal'].sort(),
    );
    expect(res.body.localTotal).toBe(4);
    expect(res.body.grTotal).toBe(4);
    expect(res.body.localOnly).toEqual(['X']);
    expect(res.body.grOnly).toEqual(['Z']);
    expect(res.body.localOnlyCount).toBe(res.body.localOnly.length);
    expect(res.body.grOnlyCount).toBe(res.body.grOnly.length);
  });

  it('returns 401 without auth (REQ-REC-AUTH-1)', async () => {
    const { app } = buildAppWithReconcile(['A'], ['A']);
    const res = await request(app).post('/api/admin/gr-sync/reconcile-report');
    expect(res.status).toBe(401);
  });

  it('returns 503 when GR is not configured (collaborator absent)', async () => {
    const { app } = buildApp(); // built WITHOUT a reconcile collaborator
    const res = await withAuth(request(app).post('/api/admin/gr-sync/reconcile-report'));
    expect(res.status).toBe(503);
  });
});

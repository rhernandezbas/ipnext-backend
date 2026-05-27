/**
 * Integration tests for the gr-sync admin router.
 * Covers the reset-clients-cursor endpoint (auth + backfill trigger).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { InMemorySyncStateRepository } from '../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { ResetGrClientsCursor } from '../../application/use-cases/ResetGrClientsCursor';
import { createGrSyncRouter } from '../../infrastructure/http/routes/gr-sync.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import type { AuthProvider } from '../../domain/ports/AuthProvider';

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

/**
 * Integration tests for the feature-flags admin router.
 * Covers REQ-FF-READ-1, REQ-FF-TOGGLE-1, REQ-FF-AUTH-1.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Request, Response, NextFunction } from 'express';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { ListFeatureFlags } from '../../application/use-cases/ListFeatureFlags';
import { GetFeatureFlag } from '../../application/use-cases/GetFeatureFlag';
import { SetFeatureFlag } from '../../application/use-cases/SetFeatureFlag';
import { createFeatureFlagsRouter } from '../../infrastructure/http/routes/featureFlags.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import type { AuthProvider } from '../../domain/ports/AuthProvider';

// Pass-through middleware: these tests focus on UC behaviour, not RBAC.
// The RBAC scenarios are covered in featureFlags.routes.rbac.test.ts.
const allowAllFlags = (_req: Request, _res: Response, next: NextFunction) => next();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const repo = new InMemoryFeatureFlagRepository();
  repo.seed('iclass-integration', false);

  const listUC = new ListFeatureFlags(repo);
  const getUC = new GetFeatureFlag(repo);
  const setUC = new SetFeatureFlag(repo);

  const authProvider = {
    getSession: jest.fn().mockResolvedValue({ id: '1', email: 'admin@test.com', role: 'admin' }),
  } as unknown as AuthProvider;

  app.use(
    '/api/admin/feature-flags',
    createFeatureFlagsRouter(authProvider, undefined, listUC, getUC, setUC, allowAllFlags),
  );

  // Exercise the REAL production error handler so the FLAG_NOT_FOUND mapping
  // cannot drift out from under this test.
  app.use(errorHandler);

  return { app, repo };
}

function withAuth(req: request.Test) {
  return req.set('Cookie', 'auth_token=mock-token');
}

describe('GET /api/admin/feature-flags', () => {
  it('returns the list of flags', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).get('/api/admin/feature-flags'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ key: 'iclass-integration', enabled: false });
    expect(typeof res.body[0].updatedAt).toBe('string');
  });

  it('returns 401 without auth', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/feature-flags');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/feature-flags/:key', () => {
  it('returns an existing flag', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).get('/api/admin/feature-flags/iclass-integration'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'iclass-integration', enabled: false });
  });

  it('returns 404 FLAG_NOT_FOUND for unknown flag', async () => {
    const { app } = buildApp();
    const res = await withAuth(request(app).get('/api/admin/feature-flags/no-existe'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('FLAG_NOT_FOUND');
  });

  it('returns 401 without auth', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/feature-flags/iclass-integration');
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/admin/feature-flags/:key', () => {
  it('toggles the flag and persists the change', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).patch('/api/admin/feature-flags/iclass-integration').send({ enabled: true }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'iclass-integration', enabled: true });

    const after = await withAuth(request(app).get('/api/admin/feature-flags/iclass-integration'));
    expect(after.body.enabled).toBe(true);
  });

  it('returns 400 VALIDATION_ERROR for invalid body', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).patch('/api/admin/feature-flags/iclass-integration').send({ enabled: 'yes' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 FLAG_NOT_FOUND when toggling unknown flag', async () => {
    const { app } = buildApp();
    const res = await withAuth(
      request(app).patch('/api/admin/feature-flags/no-existe').send({ enabled: true }),
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('FLAG_NOT_FOUND');
  });

  it('returns 401 without auth', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch('/api/admin/feature-flags/iclass-integration')
      .send({ enabled: true });
    expect(res.status).toBe(401);
  });
});

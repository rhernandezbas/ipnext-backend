/**
 * Route tests for /api/admin/iclass/so-types/* endpoints.
 * Uses in-memory repos (InMemoryIClassSoTypeRepository + InMemoryIClassClient).
 * Exercises the real errorHandler to verify error-to-HTTP mapping.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryIClassSoTypeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { SyncIClassSoTypes } from '../../application/use-cases/SyncIClassSoTypes';
import { ListIClassSoTypes } from '../../application/use-cases/ListIClassSoTypes';
import { SyncIClassNodes } from '../../application/use-cases/SyncIClassNodes';
import { ListIClassNodeCatalog } from '../../application/use-cases/ListIClassNodeCatalog';
import { createIClassAdminRouter } from '../../infrastructure/http/routes/iclass-admin.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { IClassNodeRepository, UpsertNodeInput } from '../../domain/ports/IClassNodeRepository';
import { IClassSoTypeRepository } from '../../domain/ports/IClassSoTypeRepository';

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' };
  }
}

function buildApp(opts: { iclassFails?: boolean } = {}) {
  const soTypeRepo = new InMemoryIClassSoTypeRepository();
  const iclassClient = new InMemoryIClassClient();

  if (opts.iclassFails) {
    iclassClient.failureMode = 'unavailable';
  } else {
    iclassClient.serviceOrderTypes = [
      { code: 'INSTALL', description: 'Instalación' },
      { code: 'REPAIR', description: 'Reparación' },
    ];
  }

  const syncUC = new SyncIClassSoTypes(iclassClient, soTypeRepo);
  const listUC = new ListIClassSoTypes(soTypeRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin/iclass', createIClassAdminRouter(syncUC, listUC, new FakeAuthProvider(), undefined));
  app.use(errorHandler);

  return { app, soTypeRepo, iclassClient };
}

// ─── POST /api/admin/iclass/so-types/sync ─────────────────────────────────────

describe('POST /api/admin/iclass/so-types/sync', () => {
  it('REQ-HTTP-SYNC-1: 200 with sync summary on success', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/iclass/so-types/sync')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(2);
    expect(res.body.deactivated).toBe(0);
    // Also returns created/updated/reactivated (all 5 fields)
    expect(typeof res.body.created).toBe('number');
    expect(typeof res.body.updated).toBe('number');
    expect(typeof res.body.reactivated).toBe('number');
  });

  it('REQ-HTTP-SYNC-2: 401 without auth token', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/admin/iclass/so-types/sync');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('503/502 when IClass is unavailable', async () => {
    const { app } = buildApp({ iclassFails: true });

    const res = await request(app)
      .post('/api/admin/iclass/so-types/sync')
      .set('Cookie', 'auth_token=fake');

    // ICLASS_UNAVAILABLE maps to 502 in errorHandler
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ICLASS_UNAVAILABLE');
  });
});

// ─── GET /api/admin/iclass/so-types ───────────────────────────────────────────

describe('GET /api/admin/iclass/so-types', () => {
  async function buildAppWithSeededData() {
    const { app, soTypeRepo } = buildApp();
    // Seed: 2 active, 1 inactive
    await soTypeRepo.upsertByCode({ code: 'ACTIVE_1', description: 'Active One' });
    await soTypeRepo.upsertByCode({ code: 'ACTIVE_2', description: 'Active Two' });
    await soTypeRepo.upsertByCode({ code: 'INACTIVE', description: 'Inactive One' });
    await soTypeRepo.markInactiveExcept(['ACTIVE_1', 'ACTIVE_2']);
    return app;
  }

  it('REQ-HTTP-LIST-1: returns all entries when no filter', async () => {
    const app = await buildAppWithSeededData();

    const res = await request(app)
      .get('/api/admin/iclass/so-types')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
  });

  it('REQ-HTTP-LIST-1: ?active=true returns only active entries', async () => {
    const app = await buildAppWithSeededData();

    const res = await request(app)
      .get('/api/admin/iclass/so-types?active=true')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((item: { active: boolean }) => item.active === true)).toBe(true);
  });

  it('?active=false returns only inactive entries', async () => {
    const app = await buildAppWithSeededData();

    const res = await request(app)
      .get('/api/admin/iclass/so-types?active=false')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].active).toBe(false);
  });

  it('REQ-SHAPE-CAT-1: response items include required fields', async () => {
    const app = await buildAppWithSeededData();

    const res = await request(app)
      .get('/api/admin/iclass/so-types?active=true')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('code');
    expect(item).toHaveProperty('description');
    expect(item).toHaveProperty('active');
    expect(item).toHaveProperty('lastSyncedAt');
    expect(item).toHaveProperty('createdAt');
    expect(item).toHaveProperty('updatedAt');
  });

  it('REQ-HTTP-LIST-2: 401 without auth token', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .get('/api/admin/iclass/so-types');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});

// ─── Error path: handlers must forward DB failures to next(err) → 500 ─────────
// Regression for M2: GET /nodes and GET /so-types were `async` without try/catch,
// so a repo rejection escaped the route and hung the request (no response sent).
// A throwing repo must now surface a 500 INTERNAL_ERROR via the errorHandler.

class ThrowingSoTypeRepository implements IClassSoTypeRepository {
  async list(): Promise<never> {
    throw new Error('db down');
  }
  async getById(): Promise<never> {
    throw new Error('db down');
  }
  async getByCode(): Promise<never> {
    throw new Error('db down');
  }
  async upsertByCode(): Promise<never> {
    throw new Error('db down');
  }
  async markInactiveExcept(): Promise<never> {
    throw new Error('db down');
  }
}

class ThrowingNodeRepository implements IClassNodeRepository {
  async list(): Promise<never> {
    throw new Error('db down');
  }
  async getById(): Promise<never> {
    throw new Error('db down');
  }
  async upsertByNodeId(_node: UpsertNodeInput): Promise<never> {
    throw new Error('db down');
  }
  async markInactiveExcept(): Promise<never> {
    throw new Error('db down');
  }
}

function buildAppWithFailingRepos() {
  const iclassClient = new InMemoryIClassClient();
  const soTypeRepo = new ThrowingSoTypeRepository();
  const nodeRepo = new ThrowingNodeRepository();

  const syncSoTypes = new SyncIClassSoTypes(iclassClient, soTypeRepo);
  const listSoTypes = new ListIClassSoTypes(soTypeRepo);
  const syncNodes = new SyncIClassNodes(iclassClient, nodeRepo);
  const listNodes = new ListIClassNodeCatalog(nodeRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/admin/iclass',
    createIClassAdminRouter(syncSoTypes, listSoTypes, new FakeAuthProvider(), undefined, syncNodes, listNodes),
  );
  app.use(errorHandler);
  return app;
}

describe('IClass admin routes — DB failure forwards to errorHandler (M2)', () => {
  it('GET /nodes → 500 INTERNAL_ERROR when the repo throws (does not hang)', async () => {
    const app = buildAppWithFailingRepos();
    const res = await request(app)
      .get('/api/admin/iclass/nodes')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('GET /so-types → 500 INTERNAL_ERROR when the repo throws (does not hang)', async () => {
    const app = buildAppWithFailingRepos();
    const res = await request(app)
      .get('/api/admin/iclass/so-types')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

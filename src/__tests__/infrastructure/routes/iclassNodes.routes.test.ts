/**
 * Route tests for /api/admin/iclass/nodes/* (REQ-NCAT-1, REQ-NCAT-2).
 * In-memory repos + real errorHandler so the error→HTTP mapping cannot drift.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryIClassNodeRepository } from '../../../infrastructure/adapters/in-memory/InMemoryIClassNodeRepository';
import { InMemoryIClassClient } from '../../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassSoTypeRepository } from '../../../infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository';
import { SyncIClassNodes } from '../../../application/use-cases/SyncIClassNodes';
import { ListIClassNodeCatalog } from '../../../application/use-cases/ListIClassNodeCatalog';
import { SyncIClassSoTypes } from '../../../application/use-cases/SyncIClassSoTypes';
import { ListIClassSoTypes } from '../../../application/use-cases/ListIClassSoTypes';
import { createIClassAdminRouter } from '../../../infrastructure/http/routes/iclass-admin.routes';
import { errorHandler } from '../../../infrastructure/http/middleware/errorHandler';
import { User } from '../../../domain/entities/auth';
import { AuthProvider } from '../../../domain/ports/AuthProvider';

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
  const nodeRepo = new InMemoryIClassNodeRepository();
  const soTypeRepo = new InMemoryIClassSoTypeRepository();
  const iclass = new InMemoryIClassClient();

  if (opts.iclassFails) {
    iclass.failureMode = 'unavailable';
  } else {
    iclass.nodes = [
      { nodeId: 1, code: 'Mercedes', description: 'Mercedes' },
      { nodeId: 2, code: 'Lujan', description: 'Lujan' },
      { nodeId: 10, code: 'Main', description: 'agrupador' },
    ];
  }

  const syncNodes = new SyncIClassNodes(iclass, nodeRepo);
  const listNodes = new ListIClassNodeCatalog(nodeRepo);
  const syncSoTypes = new SyncIClassSoTypes(iclass, soTypeRepo);
  const listSoTypes = new ListIClassSoTypes(soTypeRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/admin/iclass',
    createIClassAdminRouter(syncSoTypes, listSoTypes, new FakeAuthProvider(), syncNodes, listNodes),
  );
  app.use(errorHandler);

  return { app, nodeRepo, iclass };
}

const COOKIE = 'auth_token=fake';

describe('POST /api/admin/iclass/nodes/sync', () => {
  it('REQ-NCAT-1: 200 with counts on success, grouping node → selectable=false', async () => {
    const { app, nodeRepo } = buildApp();
    const res = await request(app).post('/api/admin/iclass/nodes/sync').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(3);
    expect(res.body.created).toBe(3);
    expect(res.body.deactivated).toBe(0);

    const selectable = await nodeRepo.list({ selectable: true });
    expect(selectable).toHaveLength(2);
  });

  it('401 without auth', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/admin/iclass/nodes/sync');
    expect(res.status).toBe(401);
  });

  it('502 ICLASS_UNAVAILABLE when IClass is down', async () => {
    const { app } = buildApp({ iclassFails: true });
    const res = await request(app).post('/api/admin/iclass/nodes/sync').set('Cookie', COOKIE);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ICLASS_UNAVAILABLE');
  });
});

describe('GET /api/admin/iclass/nodes', () => {
  async function seeded() {
    const { app, nodeRepo } = buildApp();
    await nodeRepo.upsertByNodeId({ nodeId: 1, code: 'Mercedes', description: 'Mercedes', selectable: true });
    await nodeRepo.upsertByNodeId({ nodeId: 2, code: 'Lujan', description: 'Lujan', selectable: true });
    await nodeRepo.upsertByNodeId({ nodeId: 10, code: 'Main', description: 'Main', selectable: false });
    await nodeRepo.upsertByNodeId({ nodeId: 3, code: 'Vieja', description: 'Vieja', selectable: true });
    await nodeRepo.markInactiveExcept([1, 2, 10]); // deactivate node 3
    return app;
  }

  it('no filter → all 4 items with wire shape (lastSyncedAt ISO)', async () => {
    const app = await seeded();
    const res = await request(app).get('/api/admin/iclass/nodes').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(4);
    const item = res.body.items[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('nodeId');
    expect(item).toHaveProperty('code');
    expect(item).toHaveProperty('description');
    expect(item).toHaveProperty('active');
    expect(item).toHaveProperty('selectable');
    expect(typeof item.lastSyncedAt).toBe('string');
    expect(item.lastSyncedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('REQ-NCAT-2: active=true&selectable=true → only assignable nodes', async () => {
    const app = await seeded();
    const res = await request(app)
      .get('/api/admin/iclass/nodes?active=true&selectable=true')
      .set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.every((i: { active: boolean; selectable: boolean }) => i.active && i.selectable)).toBe(true);
  });

  it('invalid query → 400 VALIDATION_ERROR', async () => {
    const app = await seeded();
    const res = await request(app).get('/api/admin/iclass/nodes?active=maybe').set('Cookie', COOKIE);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('401 without auth', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/iclass/nodes');
    expect(res.status).toBe(401);
  });
});

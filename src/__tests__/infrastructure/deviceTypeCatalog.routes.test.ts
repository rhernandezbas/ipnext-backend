/**
 * C.1 — Integration tests for deviceTypeCatalog.routes.ts
 * Covers spec F1-8, F1-9: CRUD endpoints with inventory.read / inventory.manage RBAC guards.
 *
 * Pattern mirrors workflows.routes.rbac.test.ts (EchoAuthProvider + in-memory RBAC).
 */

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createDeviceTypeCatalogRouter } from '@infrastructure/http/routes/deviceTypeCatalog.routes';

import { ListDeviceType } from '@application/use-cases/ListDeviceType';
import { GetDeviceType } from '@application/use-cases/GetDeviceType';
import { CreateDeviceType } from '@application/use-cases/CreateDeviceType';
import { UpdateDeviceType } from '@application/use-cases/UpdateDeviceType';
import { DeleteDeviceType } from '@application/use-cases/DeleteDeviceType';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

// Echo cookie token back as userId — same pattern as workflows.routes.rbac.test.ts
class EchoAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'x', username: 't', email: 't@t.com', role: 'admin' as const },
      cookieValue: 'x',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    return { id: token, username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

interface Fixture {
  app: express.Express;
  catalogRepo: InMemoryDeviceTypeCatalogRepository;
  catalogService: DeviceTypeCatalogService;
  manageUserId: string;     // inventory.manage + inventory.read
  readOnlyUserId: string;   // inventory.read only
  noPermUserId: string;     // no inventory perms
  superAdminUserId: string;
}

async function buildApp(): Promise<Fixture> {
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher       = new InMemoryPasswordHasher();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  // Wire listRolesForUser + listPermissionsForUser through in-memory pivots
  userRepo.listRolesForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const roles = await Promise.all(roleIds.map((id) => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('@domain/entities/rbac').RbacPermission[] = [];
    const allPerms = await permRepo.listAll();
    for (const roleId of roleIds) {
      const permIds = await rolePermRepo.listForRole(roleId);
      for (const permId of permIds) {
        const p = allPerms.find((ap) => ap.id === permId);
        if (p) perms.push(p);
      }
    }
    return perms;
  };

  // Roles
  const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
  const managerRole    = await roleRepo.create({ code: 'inv_manager', label: 'Inv Manager', isSystem: false });
  const readerRole     = await roleRepo.create({ code: 'inv_reader',  label: 'Inv Reader',  isSystem: false });

  // Permissions
  const managePerm = await permRepo.seed({ moduleCode: 'inventory', action: 'manage' });
  const readPerm   = await permRepo.seed({ moduleCode: 'inventory', action: 'read' });

  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  // Users
  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const superAdminUser = await mkUser('super');
  await userRoleRepo.assign(superAdminUser.id, superAdminRole.id);

  const manageUser = await mkUser('manager');
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const noPermUser = await mkUser('noperm');

  // Catalog
  const catalogRepo    = new InMemoryDeviceTypeCatalogRepository();
  const catalogService = new DeviceTypeCatalogService(catalogRepo);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/inventory',
    createDeviceTypeCatalogRouter(
      new EchoAuthProvider(),
      undefined,
      requirePerm,
      new ListDeviceType(catalogRepo),
      new GetDeviceType(catalogRepo),
      new CreateDeviceType(catalogRepo),
      new UpdateDeviceType(catalogRepo),
      new DeleteDeviceType(catalogRepo),
      catalogService,
    ),
  );
  app.use(errorHandler);

  return {
    app,
    catalogRepo,
    catalogService,
    manageUserId: manageUser.id,
    readOnlyUserId: readUser.id,
    noPermUserId: noPermUser.id,
    superAdminUserId: superAdminUser.id,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ─── GET list ─────────────────────────────────────────────────────────────────

describe('GET /api/inventory/device-types', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('with inventory.read → 200 array', async () => {
    await fx.catalogRepo.create({ name: 'ONU', active: true, sortOrder: 0 });
    const res = await asUser(request(fx.app).get('/api/inventory/device-types'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it('no token → 401', async () => {
    const res = await request(fx.app).get('/api/inventory/device-types');
    expect(res.status).toBe(401);
  });

  it('no inventory.read → 403 PERMISSION_DENIED', async () => {
    const res = await asUser(request(fx.app).get('/api/inventory/device-types'), fx.noPermUserId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('super_admin → 200 (short-circuit)', async () => {
    const res = await asUser(request(fx.app).get('/api/inventory/device-types'), fx.superAdminUserId);
    expect(res.status).toBe(200);
  });
});

// ─── GET by-id ────────────────────────────────────────────────────────────────

describe('GET /api/inventory/device-types/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('known id → 200', async () => {
    const item = await fx.catalogRepo.create({ name: 'ROUTER', active: true, sortOrder: 1 });
    const res = await asUser(request(fx.app).get(`/api/inventory/device-types/${item.id}`), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('ROUTER');
  });

  it('unknown id → 404 DEVICE_TYPE_NOT_FOUND', async () => {
    const res = await asUser(request(fx.app).get('/api/inventory/device-types/nonexistent'), fx.readOnlyUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DEVICE_TYPE_NOT_FOUND');
  });
});

// ─── POST ─────────────────────────────────────────────────────────────────────

describe('POST /api/inventory/device-types', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no token → 401', async () => {
    const res = await request(fx.app).post('/api/inventory/device-types').send({ name: 'ONU' });
    expect(res.status).toBe(401);
  });

  it('auth but WITHOUT inventory.manage → 403', async () => {
    const res = await asUser(
      request(fx.app).post('/api/inventory/device-types').send({ name: 'ONU' }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('with inventory.manage → 201', async () => {
    const res = await asUser(
      request(fx.app).post('/api/inventory/device-types').send({ name: 'ONU' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('ONU');
  });

  it('duplicate name → 409 DEVICE_TYPE_NAME_CONFLICT', async () => {
    await fx.catalogRepo.create({ name: 'ONU', active: true, sortOrder: 0 });
    const res = await asUser(
      request(fx.app).post('/api/inventory/device-types').send({ name: 'onu' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEVICE_TYPE_NAME_CONFLICT');
  });

  it('invalid body → 400 VALIDATION_ERROR', async () => {
    const res = await asUser(
      request(fx.app).post('/api/inventory/device-types').send({ name: '' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('super_admin → 201 (short-circuit)', async () => {
    const res = await asUser(
      request(fx.app).post('/api/inventory/device-types').send({ name: 'ANTENA' }),
      fx.superAdminUserId,
    );
    expect(res.status).toBe(201);
  });
});

// ─── PUT ──────────────────────────────────────────────────────────────────────

describe('PUT /api/inventory/device-types/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('happy path → 200', async () => {
    const item = await fx.catalogRepo.create({ name: 'ONU', active: true, sortOrder: 0 });
    const res = await asUser(
      request(fx.app).put(`/api/inventory/device-types/${item.id}`).send({ label: 'Optical Network Unit' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Optical Network Unit');
  });

  it('unknown id → 404 DEVICE_TYPE_NOT_FOUND', async () => {
    const res = await asUser(
      request(fx.app).put('/api/inventory/device-types/nonexistent').send({ label: 'X' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DEVICE_TYPE_NOT_FOUND');
  });

  it('rename to existing name → 409 DEVICE_TYPE_NAME_CONFLICT', async () => {
    await fx.catalogRepo.create({ name: 'ONU', active: true, sortOrder: 0 });
    const item2 = await fx.catalogRepo.create({ name: 'ROUTER', active: true, sortOrder: 1 });
    const res = await asUser(
      request(fx.app).put(`/api/inventory/device-types/${item2.id}`).send({ name: 'ONU' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEVICE_TYPE_NAME_CONFLICT');
  });

  it('no inventory.manage → 403', async () => {
    const item = await fx.catalogRepo.create({ name: 'ONU', active: true, sortOrder: 0 });
    const res = await asUser(
      request(fx.app).put(`/api/inventory/device-types/${item.id}`).send({ label: 'X' }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });

  // #43 DEBT — renaming OTROS is blocked at the route with 422 NON_RENAMEABLE.
  it('rename OTROS → 422 DEVICE_TYPE_NON_RENAMEABLE (#43 debt)', async () => {
    const otros = await fx.catalogRepo.create({ name: 'OTROS', active: true, sortOrder: 4 });
    const res = await asUser(
      request(fx.app).put(`/api/inventory/device-types/${otros.id}`).send({ name: 'MISC' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DEVICE_TYPE_NON_RENAMEABLE');
  });

  it('editing OTROS label/active only → 200 (name frozen, rest editable) (#43 debt)', async () => {
    const otros = await fx.catalogRepo.create({ name: 'OTROS', active: true, sortOrder: 4 });
    const res = await asUser(
      request(fx.app).put(`/api/inventory/device-types/${otros.id}`).send({ label: 'Otros equipos', active: false }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Otros equipos');
    expect(res.body.active).toBe(false);
    expect(res.body.name).toBe('OTROS');
  });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

describe('DELETE /api/inventory/device-types/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('happy path → 204', async () => {
    const item = await fx.catalogRepo.create({ name: 'ANTENA', active: true, sortOrder: 2 });
    const res = await asUser(
      request(fx.app).delete(`/api/inventory/device-types/${item.id}`),
      fx.manageUserId,
    );
    expect(res.status).toBe(204);
  });

  it('unknown id → 404 DEVICE_TYPE_NOT_FOUND', async () => {
    const res = await asUser(
      request(fx.app).delete('/api/inventory/device-types/nonexistent'),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DEVICE_TYPE_NOT_FOUND');
  });

  it('in-use → 409 DEVICE_TYPE_IN_USE', async () => {
    const item = await fx.catalogRepo.create({ name: 'ROUTER', active: true, sortOrder: 1 });
    fx.catalogRepo.itemCounts['ROUTER'] = 3;
    const res = await asUser(
      request(fx.app).delete(`/api/inventory/device-types/${item.id}`),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEVICE_TYPE_IN_USE');
  });

  it('OTROS → 409 DEVICE_TYPE_PROTECTED', async () => {
    const item = await fx.catalogRepo.create({ name: 'OTROS', active: true, sortOrder: 4 });
    const res = await asUser(
      request(fx.app).delete(`/api/inventory/device-types/${item.id}`),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEVICE_TYPE_PROTECTED');
  });

  it('no inventory.manage → 403', async () => {
    const item = await fx.catalogRepo.create({ name: 'ONU', active: true, sortOrder: 0 });
    const res = await asUser(
      request(fx.app).delete(`/api/inventory/device-types/${item.id}`),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });
});

// ─── Cache invalidation ───────────────────────────────────────────────────────

describe('Cache invalidation after POST', () => {
  it('after POST a new type via the router, service.isValid returns true', async () => {
    const fx = await buildApp();

    // Initially the cache is empty (no types seeded)
    const beforeValid = await fx.catalogService.isValid('NEWTYPE');
    expect(beforeValid).toBe(false);

    // POST a new type through the router
    const res = await asUser(
      request(fx.app).post('/api/inventory/device-types').send({ name: 'NEWTYPE' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);

    // Now the cache should be invalidated and the service should see the new type
    const afterValid = await fx.catalogService.isValid('NEWTYPE');
    expect(afterValid).toBe(true);
  });

  it('after PUT a rename, service reflects updated name', async () => {
    const fx = await buildApp();
    const item = await fx.catalogRepo.create({ name: 'OLD', active: true, sortOrder: 0 });

    // Warm the cache
    await fx.catalogService.ensure();
    expect(await fx.catalogService.isValid('OLD')).toBe(true);

    // Rename via PUT
    const res = await asUser(
      request(fx.app).put(`/api/inventory/device-types/${item.id}`).send({ name: 'NEW' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);

    // Cache invalidated — OLD is gone, NEW is there
    expect(await fx.catalogService.isValid('OLD')).toBe(false);
    expect(await fx.catalogService.isValid('NEW')).toBe(true);
  });
});

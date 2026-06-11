/**
 * #43 — seam tests for serviceCatalog.routes.ts.
 * Supertest + in-memory repos; status + body field-by-field per SC scenarios; 403 by permission.
 * Pattern mirrors deviceTypeCatalog.routes.test.ts (EchoAuthProvider + in-memory RBAC).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createServiceCatalogRouter } from '@infrastructure/http/routes/serviceCatalog.routes';

import { ListServiceCatalog } from '@application/use-cases/ListServiceCatalog';
import { CreateServiceCatalog } from '@application/use-cases/CreateServiceCatalog';
import { UpdateServiceCatalog } from '@application/use-cases/UpdateServiceCatalog';
import { DeleteServiceCatalog } from '@application/use-cases/DeleteServiceCatalog';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

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
  repo: InMemoryServiceCatalogRepository;
  manageUserId: string;
  readOnlyUserId: string;
  noPermUserId: string;
}

async function buildApp(): Promise<Fixture> {
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher       = new InMemoryPasswordHasher();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

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

  const managerRole = await roleRepo.create({ code: 'cli_manager', label: 'Cli Manager', isSystem: false });
  const readerRole  = await roleRepo.create({ code: 'cli_reader',  label: 'Cli Reader',  isSystem: false });

  const managePerm = await permRepo.seed({ moduleCode: 'clients', action: 'manage' });
  const readPerm   = await permRepo.seed({ moduleCode: 'clients', action: 'read' });

  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('manager');
  await userRoleRepo.assign(manageUser.id, managerRole.id);
  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  const noPermUser = await mkUser('noperm');

  const repo = new InMemoryServiceCatalogRepository();
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createServiceCatalogRouter(
    new EchoAuthProvider(),
    requirePerm,
    new ListServiceCatalog(repo),
    new CreateServiceCatalog(repo),
    new UpdateServiceCatalog(repo),
    new DeleteServiceCatalog(repo),
  ));
  app.use(errorHandler);

  return { app, repo, manageUserId: manageUser.id, readOnlyUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('GET /api/service-catalog', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // SC-1.1
  it('clients.read → 200 array ordered by sortOrder', async () => {
    await fx.repo.create({ name: 'TV', sortOrder: 1 });
    await fx.repo.create({ name: 'INTERNET', sortOrder: 0 });
    const res = await asUser(request(fx.app).get('/api/service-catalog'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body.map((e: any) => e.name)).toEqual(['INTERNET', 'TV']);
  });

  // SC-1.2
  it('?active=true excludes inactive entries', async () => {
    await fx.repo.create({ name: 'INTERNET', sortOrder: 0, active: true });
    await fx.repo.create({ name: 'OTROS', sortOrder: 4, active: false });
    const res = await asUser(request(fx.app).get('/api/service-catalog?active=true'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body.map((e: any) => e.name)).toEqual(['INTERNET']);
  });

  // SC-1.3
  it('no clients.read → 403', async () => {
    const res = await asUser(request(fx.app).get('/api/service-catalog'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/service-catalog', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // SC-2.1
  it('clients.manage → 201 with id and active:true', async () => {
    const res = await asUser(
      request(fx.app).post('/api/service-catalog').send({ name: 'FIBRA', label: 'Fibra óptica', sortOrder: 10 }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('FIBRA');
    expect(res.body.active).toBe(true);
  });

  // SC-2.2
  it('duplicate name → 409 SERVICE_CATALOG_NAME_CONFLICT', async () => {
    await fx.repo.create({ name: 'INTERNET', sortOrder: 0 });
    const res = await asUser(
      request(fx.app).post('/api/service-catalog').send({ name: 'INTERNET' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVICE_CATALOG_NAME_CONFLICT');
  });

  // SC-2.3
  it('only clients.read → 403', async () => {
    const res = await asUser(
      request(fx.app).post('/api/service-catalog').send({ name: 'FIBRA' }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/service-catalog/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // SC-3.1
  it('partial update → 200 reflecting new values', async () => {
    const item = await fx.repo.create({ name: 'INTERNET', sortOrder: 0 });
    const res = await asUser(
      request(fx.app).patch(`/api/service-catalog/${item.id}`).send({ label: 'Internet hogar', active: false }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Internet hogar');
    expect(res.body.active).toBe(false);
  });

  // SC-3.2
  it('name collision → 409 SERVICE_CATALOG_NAME_CONFLICT', async () => {
    await fx.repo.create({ name: 'INTERNET', sortOrder: 0 });
    const b = await fx.repo.create({ name: 'TV', sortOrder: 1 });
    const res = await asUser(
      request(fx.app).patch(`/api/service-catalog/${b.id}`).send({ name: 'INTERNET' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SERVICE_CATALOG_NAME_CONFLICT');
  });

  // SC-3.3
  it('unknown id → 404 SERVICE_CATALOG_NOT_FOUND', async () => {
    const res = await asUser(
      request(fx.app).patch('/api/service-catalog/nope').send({ label: 'x' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SERVICE_CATALOG_NOT_FOUND');
  });

  // W-1 — OTROS name is frozen (bypasses the non-deletable guard otherwise).
  it('renaming OTROS → 422 SERVICE_CATALOG_NON_RENAMEABLE', async () => {
    const otros = await fx.repo.create({ name: 'OTROS', sortOrder: 4 });
    const res = await asUser(
      request(fx.app).patch(`/api/service-catalog/${otros.id}`).send({ name: 'MISC' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SERVICE_CATALOG_NON_RENAMEABLE');
  });

  it('editing OTROS label only → 200 (name frozen, other fields editable)', async () => {
    const otros = await fx.repo.create({ name: 'OTROS', sortOrder: 4 });
    const res = await asUser(
      request(fx.app).patch(`/api/service-catalog/${otros.id}`).send({ label: 'Otros' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.label).toBe('Otros');
    expect(res.body.name).toBe('OTROS');
  });
});

describe('DELETE /api/service-catalog/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // SC-4.1
  it('unused entry → 204', async () => {
    const item = await fx.repo.create({ name: 'FIBRA', sortOrder: 5 });
    const res = await asUser(request(fx.app).delete(`/api/service-catalog/${item.id}`), fx.manageUserId);
    expect(res.status).toBe(204);
  });

  // SC-4.2
  it('in-use → 422 SERVICE_IN_USE', async () => {
    const item = await fx.repo.create({ name: 'INTERNET', sortOrder: 0 });
    fx.repo.itemCounts[item.id] = 2;
    const res = await asUser(request(fx.app).delete(`/api/service-catalog/${item.id}`), fx.manageUserId);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SERVICE_IN_USE');
  });

  // SC-4.3
  it('OTROS → 422 SERVICE_CATALOG_NON_DELETABLE', async () => {
    const item = await fx.repo.create({ name: 'OTROS', sortOrder: 4 });
    const res = await asUser(request(fx.app).delete(`/api/service-catalog/${item.id}`), fx.manageUserId);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SERVICE_CATALOG_NON_DELETABLE');
  });

  // SC-4.4
  it('unknown id → 404 SERVICE_CATALOG_NOT_FOUND', async () => {
    const res = await asUser(request(fx.app).delete('/api/service-catalog/nope'), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SERVICE_CATALOG_NOT_FOUND');
  });
});

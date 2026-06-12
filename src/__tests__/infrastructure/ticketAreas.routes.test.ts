/**
 * Integration tests for ticketAreas.routes.ts
 * Full seam: supertest → router → use-cases → InMemory repo.
 * Mirrors deviceTypeCatalog.routes.test.ts (EchoAuthProvider + in-memory RBAC).
 *
 * Read guard:  tickets.read
 * Write guard: tickets.manage
 */

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createTicketAreasRouter } from '@infrastructure/http/routes/ticketAreas.routes';

import { ListTicketAreas } from '@application/use-cases/ListTicketAreas';
import { GetTicketArea } from '@application/use-cases/GetTicketArea';
import { CreateTicketArea } from '@application/use-cases/CreateTicketArea';
import { UpdateTicketArea } from '@application/use-cases/UpdateTicketArea';
import { DeleteTicketArea } from '@application/use-cases/DeleteTicketArea';

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
  areaRepo: InMemoryTicketAreaCatalogRepository;
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

  const managerRole  = await roleRepo.create({ code: 'tkt_manager', label: 'Tkt Manager', isSystem: false });
  const readerRole   = await roleRepo.create({ code: 'tkt_reader',  label: 'Tkt Reader',  isSystem: false });

  const managePerm = await permRepo.seed({ moduleCode: 'tickets', action: 'manage' });
  const readPerm   = await permRepo.seed({ moduleCode: 'tickets', action: 'read' });

  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const manageUser   = await mkUser('manager');
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const noPermUser = await mkUser('noperm');

  const areaRepo = new InMemoryTicketAreaCatalogRepository();

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/tickets/areas',
    createTicketAreasRouter(
      new EchoAuthProvider(),
      requirePerm,
      new ListTicketAreas(areaRepo),
      new GetTicketArea(areaRepo),
      new CreateTicketArea(areaRepo),
      new UpdateTicketArea(areaRepo),
      new DeleteTicketArea(areaRepo),
    ),
  );
  app.use(errorHandler);

  return { app, areaRepo, manageUserId: manageUser.id, readOnlyUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ─── GET list ─────────────────────────────────────────────────────────────────

describe('GET /api/tickets/areas', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('with tickets.read → 200 array', async () => {
    await fx.areaRepo.create({ name: 'Soporte' });
    const res = await asUser(request(fx.app).get('/api/tickets/areas'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it('no token → 401', async () => {
    const res = await request(fx.app).get('/api/tickets/areas');
    expect(res.status).toBe(401);
  });

  it('no tickets.read → 403', async () => {
    const res = await asUser(request(fx.app).get('/api/tickets/areas'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });
});

// ─── GET by id ────────────────────────────────────────────────────────────────

describe('GET /api/tickets/areas/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('returns 200 with area for readers', async () => {
    const area = await fx.areaRepo.create({ name: 'Soporte' });
    const res = await asUser(request(fx.app).get(`/api/tickets/areas/${area.id}`), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Soporte');
  });

  it('returns 404 for missing id', async () => {
    const res = await asUser(request(fx.app).get('/api/tickets/areas/nonexistent'), fx.readOnlyUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_AREA_NOT_FOUND');
  });
});

// ─── POST ─────────────────────────────────────────────────────────────────────

describe('POST /api/tickets/areas', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('with tickets.manage → 201 created', async () => {
    const res = await asUser(
      request(fx.app).post('/api/tickets/areas').send({ name: 'Soporte' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Soporte');
    expect(res.body.id).toBeTruthy();
  });

  it('returns 409 on duplicate name', async () => {
    await asUser(request(fx.app).post('/api/tickets/areas').send({ name: 'Soporte' }), fx.manageUserId);
    const res = await asUser(
      request(fx.app).post('/api/tickets/areas').send({ name: 'Soporte' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TICKET_AREA_NAME_CONFLICT');
  });

  it('without tickets.manage → 403', async () => {
    const res = await asUser(
      request(fx.app).post('/api/tickets/areas').send({ name: 'Soporte' }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 on missing name', async () => {
    const res = await asUser(
      request(fx.app).post('/api/tickets/areas').send({}),
      fx.manageUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('fix: trims the name — 201 created without trailing whitespace', async () => {
    const res = await asUser(
      request(fx.app).post('/api/tickets/areas').send({ name: '  Soporte  ' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Soporte');
  });

  it('fix: whitespace-only name → 400 (trim collapses to empty)', async () => {
    const res = await asUser(
      request(fx.app).post('/api/tickets/areas').send({ name: '   ' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('fix: trailing whitespace cannot dodge the conflict check → 409', async () => {
    await asUser(request(fx.app).post('/api/tickets/areas').send({ name: 'Soporte' }), fx.manageUserId);
    // 'Soporte ' would slip past the uniqueness check without .trim().
    const res = await asUser(
      request(fx.app).post('/api/tickets/areas').send({ name: 'Soporte ' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TICKET_AREA_NAME_CONFLICT');
  });
});

// ─── PUT ──────────────────────────────────────────────────────────────────────

describe('PUT /api/tickets/areas/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('with tickets.manage → 200 updated', async () => {
    const area = await fx.areaRepo.create({ name: 'Soporte' });
    const res = await asUser(
      request(fx.app).put(`/api/tickets/areas/${area.id}`).send({ name: 'Soporte Técnico' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Soporte Técnico');
  });

  it('returns 409 on name conflict', async () => {
    await fx.areaRepo.create({ name: 'Facturación' });
    const area2 = await fx.areaRepo.create({ name: 'Soporte' });
    const res = await asUser(
      request(fx.app).put(`/api/tickets/areas/${area2.id}`).send({ name: 'Facturación' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TICKET_AREA_NAME_CONFLICT');
  });

  it('returns 404 on missing area', async () => {
    const res = await asUser(
      request(fx.app).put('/api/tickets/areas/nonexistent').send({ name: 'X' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_AREA_NOT_FOUND');
  });

  it('without tickets.manage → 403', async () => {
    const area = await fx.areaRepo.create({ name: 'Soporte' });
    const res = await asUser(
      request(fx.app).put(`/api/tickets/areas/${area.id}`).send({ name: 'X' }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

describe('DELETE /api/tickets/areas/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('with tickets.manage → 204', async () => {
    const area = await fx.areaRepo.create({ name: 'Soporte' });
    const res = await asUser(request(fx.app).delete(`/api/tickets/areas/${area.id}`), fx.manageUserId);
    expect(res.status).toBe(204);
  });

  it('returns 404 on missing area', async () => {
    const res = await asUser(request(fx.app).delete('/api/tickets/areas/nonexistent'), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TICKET_AREA_NOT_FOUND');
  });

  it('returns 409 when area is in use', async () => {
    const area = await fx.areaRepo.create({ name: 'Soporte' });
    fx.areaRepo.ticketCounts[area.id] = 2;
    const res = await asUser(request(fx.app).delete(`/api/tickets/areas/${area.id}`), fx.manageUserId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TICKET_AREA_IN_USE');
  });

  it('without tickets.manage → 403', async () => {
    const area = await fx.areaRepo.create({ name: 'Soporte' });
    const res = await asUser(request(fx.app).delete(`/api/tickets/areas/${area.id}`), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });
});

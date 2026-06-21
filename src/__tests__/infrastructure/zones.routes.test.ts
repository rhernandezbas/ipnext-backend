import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryZoneRepository } from '@infrastructure/adapters/in-memory/InMemoryZoneRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createZonesRouter } from '@infrastructure/http/routes/zones.routes';

import { ListZones } from '@application/use-cases/ListZones';
import { CreateZone } from '@application/use-cases/CreateZone';
import { GetZone } from '@application/use-cases/GetZone';
import { UpdateZone } from '@application/use-cases/UpdateZone';
import { DeleteZone } from '@application/use-cases/DeleteZone';

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
  zoneRepo: InMemoryZoneRepository;
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
    const roles = await Promise.all(roleIds.map(id => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('@domain/entities/rbac').RbacPermission[] = [];
    const allPerms = await permRepo.listAll();
    for (const roleId of roleIds) {
      const permIds = await rolePermRepo.listForRole(roleId);
      for (const permId of permIds) {
        const p = allPerms.find(ap => ap.id === permId);
        if (p) perms.push(p);
      }
    }
    return perms;
  };

  const managerRole = await roleRepo.create({ code: 'zone_manager', label: 'Zone Manager', isSystem: false });
  const readerRole  = await roleRepo.create({ code: 'zone_reader',  label: 'Zone Reader',  isSystem: false });

  const managePerm = await permRepo.seed({ moduleCode: 'zones', action: 'manage' });
  const readPerm   = await permRepo.seed({ moduleCode: 'zones', action: 'read' });

  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: login + '@x.com', login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('manager');
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const noPermUser = await mkUser('noperm');

  const zoneRepo = new InMemoryZoneRepository();
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api',
    createZonesRouter(
      new EchoAuthProvider(),
      undefined,
      requirePerm,
      new ListZones(zoneRepo),
      new CreateZone(zoneRepo),
      new GetZone(zoneRepo),
      new UpdateZone(zoneRepo),
      new DeleteZone(zoneRepo),
    ),
  );
  app.use(errorHandler);

  return { app, zoneRepo, manageUserId: manageUser.id, readOnlyUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', 'auth_token=' + userId);
}

const validBody = {
  name: 'Norte',
  color: '#22c55e',
  points: [
    { lat: -34.6037, lng: -58.3816 },
    { lat: -34.6,    lng: -58.4    },
    { lat: -34.62,   lng: -58.38   },
  ],
};

// ── GET /api/zones ────────────────────────────────────────────────────────────

describe('GET /api/zones', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no token => 401', async () => {
    const res = await request(fx.app).get('/api/zones');
    expect(res.status).toBe(401);
  });

  it('no zones.read => 403', async () => {
    const res = await asUser(request(fx.app).get('/api/zones'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('zones.read only => 200 empty array', async () => {
    const res = await asUser(request(fx.app).get('/api/zones'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it('returns zones with correct DTO shape', async () => {
    await fx.zoneRepo.create({ name: 'Norte', color: '#22c55e', points: validBody.points });
    const res = await asUser(request(fx.app).get('/api/zones'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const z = res.body[0];
    expect(z.id).toBeDefined();
    expect(z.name).toBe('Norte');
    expect(z.color).toBe('#22c55e');
    expect(Array.isArray(z.points)).toBe(true);
    expect(z.points).toHaveLength(3);
    expect(z.createdAt).toBeDefined();
    expect(z.updatedAt).toBeDefined();
    expect(z['_count']).toBeUndefined();
    // S3 — pin exact DTO shape: any extra Prisma field leaking fails this test
    expect(Object.keys(z).sort()).toEqual(['color', 'createdAt', 'description', 'id', 'name', 'points', 'updatedAt']);
  });
});

// ── POST /api/zones ───────────────────────────────────────────────────────────

describe('POST /api/zones', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no token => 401', async () => {
    const res = await request(fx.app).post('/api/zones').send(validBody);
    expect(res.status).toBe(401);
  });

  it('zones.read only (no manage) => 403', async () => {
    const res = await asUser(request(fx.app).post('/api/zones'), fx.readOnlyUserId).send(validBody);
    expect(res.status).toBe(403);
  });

  it('valid body => 201 with ZoneDto', async () => {
    const res = await asUser(request(fx.app).post('/api/zones'), fx.manageUserId).send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Norte');
    expect(res.body.color).toBe('#22c55e');
    expect(res.body.points).toHaveLength(3);
    expect(res.body.description).toBeNull();
  });

  it('fewer than 3 points => 422', async () => {
    const res = await asUser(request(fx.app).post('/api/zones'), fx.manageUserId).send({
      ...validBody,
      points: [validBody.points[0], validBody.points[1]],
    });
    expect(res.status).toBe(422);
  });

  it('invalid color => 422', async () => {
    const res = await asUser(request(fx.app).post('/api/zones'), fx.manageUserId).send({
      ...validBody,
      color: 'red',
    });
    expect(res.status).toBe(422);
  });

  it('missing name => 422', async () => {
    const res = await asUser(request(fx.app).post('/api/zones'), fx.manageUserId).send({
      color: '#22c55e',
      points: validBody.points,
    });
    expect(res.status).toBe(422);
  });
});

// ── GET /api/zones/:id ────────────────────────────────────────────────────────

describe('GET /api/zones/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no token => 401', async () => {
    const res = await request(fx.app).get('/api/zones/some-id');
    expect(res.status).toBe(401);
  });

  it('no zones.read => 403', async () => {
    const res = await asUser(request(fx.app).get('/api/zones/some-id'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('unknown id => 404 ZONE_NOT_FOUND', async () => {
    const res = await asUser(request(fx.app).get('/api/zones/ghost-id'), fx.readOnlyUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ZONE_NOT_FOUND');
  });

  it('existing zone => 200 with ZoneDto', async () => {
    const created = await fx.zoneRepo.create({ name: 'Sur', color: '#ef4444', points: validBody.points });
    const res = await asUser(request(fx.app).get('/api/zones/' + created.id), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
    expect(res.body.name).toBe('Sur');
  });
});

// ── PUT /api/zones/:id ────────────────────────────────────────────────────────

describe('PUT /api/zones/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no token => 401', async () => {
    const res = await request(fx.app).put('/api/zones/some-id').send({ name: 'X' });
    expect(res.status).toBe(401);
  });

  it('zones.read only => 403', async () => {
    const res = await asUser(request(fx.app).put('/api/zones/some-id'), fx.readOnlyUserId).send({ name: 'X' });
    expect(res.status).toBe(403);
  });

  it('unknown id => 404 ZONE_NOT_FOUND', async () => {
    const res = await asUser(request(fx.app).put('/api/zones/ghost-id'), fx.manageUserId).send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ZONE_NOT_FOUND');
  });

  it('valid update => 200 with updated ZoneDto', async () => {
    const created = await fx.zoneRepo.create({ name: 'Norte', color: '#22c55e', points: validBody.points });
    const res = await asUser(request(fx.app).put('/api/zones/' + created.id), fx.manageUserId)
      .send({ color: '#ef4444' });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe('#ef4444');
    expect(res.body.name).toBe('Norte');
  });

  it('invalid polygon on update => 422', async () => {
    const created = await fx.zoneRepo.create({ name: 'Norte', color: '#22c55e', points: validBody.points });
    const res = await asUser(request(fx.app).put('/api/zones/' + created.id), fx.manageUserId)
      .send({ points: [validBody.points[0], validBody.points[1]] });
    expect(res.status).toBe(422);
  });
});

// ── DELETE /api/zones/:id ─────────────────────────────────────────────────────

describe('DELETE /api/zones/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no token => 401', async () => {
    const res = await request(fx.app).delete('/api/zones/some-id');
    expect(res.status).toBe(401);
  });

  it('zones.read only => 403', async () => {
    const res = await asUser(request(fx.app).delete('/api/zones/some-id'), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });

  it('unknown id => 404 ZONE_NOT_FOUND', async () => {
    const res = await asUser(request(fx.app).delete('/api/zones/ghost-id'), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ZONE_NOT_FOUND');
  });

  it('existing zone => 204', async () => {
    const created = await fx.zoneRepo.create({ name: 'Centro', color: '#22c55e', points: validBody.points });
    const res = await asUser(request(fx.app).delete('/api/zones/' + created.id), fx.manageUserId);
    expect(res.status).toBe(204);
    const list = await asUser(request(fx.app).get('/api/zones'), fx.readOnlyUserId);
    expect(list.body).toHaveLength(0);
  });
});

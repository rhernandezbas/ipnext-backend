/**
 * GET /api/access-points — PICK-3. Catálogo de APs asignables (picker manual).
 * Gate: network.read. Patrón de fixture: contractLocation.routes.test.ts.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createAccessPointsRouter } from '@infrastructure/http/routes/accessPoints.routes';
import { ListAssignableAccessPoints } from '@application/use-cases/ListAssignableAccessPoints';
import { InMemoryAccessPointRepository } from '@infrastructure/adapters/in-memory/InMemoryAccessPointRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { createAuthMiddleware } from '@infrastructure/http/middleware/authMiddleware';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';

import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { User } from '@domain/entities/auth';
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
  accessPointRepo: InMemoryAccessPointRepository;
  readUserId: string;
  noPermUserId: string;
}

async function buildApp(): Promise<Fixture> {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher = new InMemoryPasswordHasher();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

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

  const readerRole = await roleRepo.create({ code: 'net_reader', label: 'Net Reader', isSystem: false });
  const plainRole = await roleRepo.create({ code: 'net_none', label: 'Net None', isSystem: false });
  const readPerm = await permRepo.seed({ moduleCode: 'network', action: 'read' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(noPermUser.id, plainRole.id);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const accessPointRepo = new InMemoryAccessPointRepository();
  await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-1', networkSiteId: 'N1', name: 'AP Norte', mac: null });
  await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-2', networkSiteId: 'N2', name: 'AP Sur', mac: null });
  await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-3', networkSiteId: 'N1', name: 'AP Retirado', mac: null });
  await accessPointRepo.markMissing(['dev-3'], new Date('2026-01-01T00:00:00Z'));

  const listAssignable = new ListAssignableAccessPoints(accessPointRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/access-points', createAuthMiddleware(new EchoAuthProvider()), createAccessPointsRouter(listAssignable, requirePerm));
  app.use(errorHandler);

  return { app, accessPointRepo, readUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('GET /api/access-points', () => {
  it('network.read → 200 { data: [...] }, filtra retirados', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/access-points'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((d: { name: string }) => d.name).sort()).toEqual(['AP Norte', 'AP Sur']);
  });

  it('?networkSiteId= filtra por nodo', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/access-points?networkSiteId=N1'), readUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: expect.any(String), name: 'AP Norte', mac: null, networkSiteId: 'N1' }]);
  });

  it('sin auth → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/access-points');
    expect(res.status).toBe(401);
  });

  it('sin network.read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/access-points'), noPermUserId);
    expect(res.status).toBe(403);
  });
});

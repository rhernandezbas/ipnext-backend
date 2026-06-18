/**
 * radius.routes.test.ts — sesiones RADIUS + guard de seguridad.
 *
 * /api/radius estaba SIN auth ni permiso (agujero; fix `network-routes-guard`).
 * `network.read` para listar; `network.manage` para desconectar.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createRadiusRouter } from '@infrastructure/http/routes/radius.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { InMemoryRadiusSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusSessionRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { DisconnectSession } from '@application/use-cases/DisconnectSession';

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
  readUserId: string;
  manageUserId: string;
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

  const readerRole  = await roleRepo.create({ code: 'network_reader', label: 'Network Reader', isSystem: false });
  const managerRole = await roleRepo.create({ code: 'network_manager', label: 'Network Manager', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'network', action: 'read' });
  const managePerm  = await permRepo.seed({ moduleCode: 'network', action: 'manage' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser   = await mkUser('reader');
  const manageUser = await mkUser('manager');
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const repo = new InMemoryRadiusSessionRepository();
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/radius', createRadiusRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new ListRadiusSessions(repo),
    new DisconnectSession(repo),
  ));
  app.use(errorHandler);

  return { app, readUserId: readUser.id, manageUserId: manageUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('radius.routes — sesiones + security guard (network.read / network.manage)', () => {
  it('GET /api/radius/sessions sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).get('/api/radius/sessions')).status).toBe(401);
  });
  it('GET /api/radius/sessions sin network.read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    expect((await asUser(request(app).get('/api/radius/sessions'), noPermUserId)).status).toBe(403);
  });
  it('GET /api/radius/sessions con network.read → 200 con 15 sesiones', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/radius/sessions'), readUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(15);
  });

  it('DELETE /api/radius/sessions/:id sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).delete('/api/radius/sessions/session-1')).status).toBe(401);
  });
  it('DELETE /api/radius/sessions/:id sin network.manage (solo read) → 403', async () => {
    const { app, readUserId } = await buildApp();
    expect((await asUser(request(app).delete('/api/radius/sessions/session-1'), readUserId)).status).toBe(403);
  });
  it('DELETE /api/radius/sessions/:id con network.manage → 200 { success: true }', async () => {
    const { app, manageUserId } = await buildApp();
    const res = await asUser(request(app).delete('/api/radius/sessions/session-1'), manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

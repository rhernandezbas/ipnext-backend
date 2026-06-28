/**
 * nas.pool-mode.routes.test.ts — supertest para el endpoint pppoe-pool-ip:
 *   POST /api/nas-servers/:id/pool-mode  (gate network.manage)
 *
 * Foco: el MAPEO error→HTTP de la ruta (falsificable: si el mapeo se rompe, el status cambia).
 *   200 OK (pool poblado) · 409 RadiusPoolEmptyError (RADIUS_POOL_EMPTY)
 *   · 502 orchestrator caído (ORCHESTRATOR_UNREACHABLE) · 401 sin auth · 403 sin network.manage
 *
 * Patrón espejo de nas.routes.test.ts (EchoAuthProvider + cookie token = userId + RBAC in-memory).
 * NAS seed (InMemoryNasRepository): id='1' mikrotik_api SIN poolName (target del marcado).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createNasRouter } from '@infrastructure/http/routes/nas.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { ListNasServers } from '@application/use-cases/ListNasServers';
import { GetNasServer } from '@application/use-cases/GetNasServer';
import { CreateNasServer } from '@application/use-cases/CreateNasServer';
import { UpdateNasServer } from '@application/use-cases/UpdateNasServer';
import { DeleteNasServer } from '@application/use-cases/DeleteNasServer';
import { GetRadiusConfig } from '@application/use-cases/GetRadiusConfig';
import { UpdateRadiusConfig } from '@application/use-cases/UpdateRadiusConfig';
import { SetNasPoolMode } from '@application/use-cases/SetNasPoolMode';
import type { RadiusIpPool } from '@domain/ports/RadiusOrchestratorGateway';

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

const NAS_ID = '1'; // mikrotik_api en el seed, sin poolName → target del marcado pool-mode

interface Fixture {
  app: express.Express;
  nasRepo: InMemoryNasRepository;
  manageUserId: string;
  noPermUserId: string;
}

async function buildApp(opts?: { pools?: RadiusIpPool[]; poolsUnreachable?: boolean }): Promise<Fixture> {
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

  const managerRole = await roleRepo.create({ code: 'network_manager', label: 'Network Manager', isSystem: false });
  const managePerm  = await permRepo.seed({ moduleCode: 'network', action: 'manage' });
  await rolePermRepo.grant(managerRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('manager');
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const nasRepo = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    pools: opts?.pools,
    poolsUnreachable: opts?.poolsUnreachable,
  });
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createNasRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new ListNasServers(nasRepo),
    new GetNasServer(nasRepo),
    new CreateNasServer(nasRepo),
    new UpdateNasServer(nasRepo),
    new DeleteNasServer(nasRepo),
    new GetRadiusConfig(nasRepo),
    new UpdateRadiusConfig(nasRepo),
    undefined, // findFreeIp
    new SetNasPoolMode(nasRepo, orchestrator),
  ));
  app.use(errorHandler);

  return { app, nasRepo, manageUserId: manageUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('POST /api/nas-servers/:id/pool-mode (network.manage)', () => {
  it('401 sin auth', async () => {
    const { app } = await buildApp({ pools: [{ name: 'asur-cgnat', total: 200, free: 50 }] });
    expect((await request(app).post(`/api/nas-servers/${NAS_ID}/pool-mode`).send({ poolName: 'asur-cgnat' })).status).toBe(401);
  });

  it('403 sin network.manage', async () => {
    const fx = await buildApp({ pools: [{ name: 'asur-cgnat', total: 200, free: 50 }] });
    const res = await asUser(request(fx.app).post(`/api/nas-servers/${NAS_ID}/pool-mode`).send({ poolName: 'asur-cgnat' }), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('pool poblado → 200 con poolName seteado', async () => {
    const fx = await buildApp({ pools: [{ name: 'asur-cgnat', total: 200, free: 50 }] });
    const res = await asUser(request(fx.app).post(`/api/nas-servers/${NAS_ID}/pool-mode`).send({ poolName: 'asur-cgnat' }), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.poolName).toBe('asur-cgnat');
    const reread = await fx.nasRepo.findNasServerById(NAS_ID);
    expect(reread?.poolName).toBe('asur-cgnat');
  });

  it('NUNCA devuelve secretos crudos — enmascara radiusSecret/apiPassword (leak guard)', async () => {
    const fx = await buildApp({ pools: [{ name: 'asur-cgnat', total: 200, free: 50 }] });
    // Sembrar un secreto REAL (no enmascarado) → falsificable: sin el mask de la ruta,
    // la respuesta devolvería 'REAL-SECRET-xyz' (la entidad cruda que retorna el use case).
    await fx.nasRepo.updateNasServer(NAS_ID, { radiusSecret: 'REAL-SECRET-xyz', apiPassword: 'REAL-API-pw' });
    const res = await asUser(request(fx.app).post(`/api/nas-servers/${NAS_ID}/pool-mode`).send({ poolName: 'asur-cgnat' }), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.radiusSecret).toBe('••••••••');
    expect(res.body.radiusSecret).not.toBe('REAL-SECRET-xyz');
    expect(res.body.apiPassword).toBe('••••••••');
  });

  it('pool vacío (free=0) → 409 RADIUS_POOL_EMPTY (DB sin tocar)', async () => {
    const fx = await buildApp({ pools: [{ name: 'asur-cgnat', total: 200, free: 0 }] });
    const res = await asUser(request(fx.app).post(`/api/nas-servers/${NAS_ID}/pool-mode`).send({ poolName: 'asur-cgnat' }), fx.manageUserId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RADIUS_POOL_EMPTY');
    const reread = await fx.nasRepo.findNasServerById(NAS_ID);
    expect(reread?.poolName == null).toBe(true);
  });

  it('orchestrator caído → 502 ORCHESTRATOR_UNREACHABLE', async () => {
    const fx = await buildApp({ poolsUnreachable: true });
    const res = await asUser(request(fx.app).post(`/api/nas-servers/${NAS_ID}/pool-mode`).send({ poolName: 'asur-cgnat' }), fx.manageUserId);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ORCHESTRATOR_UNREACHABLE');
  });

  it('NAS inexistente → 404 NAS_NOT_FOUND', async () => {
    const fx = await buildApp({ pools: [{ name: 'asur-cgnat', total: 200, free: 50 }] });
    const res = await asUser(request(fx.app).post('/api/nas-servers/nas-99/pool-mode').send({ poolName: 'asur-cgnat' }), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NAS_NOT_FOUND');
  });

  it('body inválido (poolName vacío) → 422 VALIDATION_ERROR', async () => {
    const fx = await buildApp({ pools: [{ name: 'asur-cgnat', total: 200, free: 50 }] });
    const res = await asUser(request(fx.app).post(`/api/nas-servers/${NAS_ID}/pool-mode`).send({ poolName: '' }), fx.manageUserId);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

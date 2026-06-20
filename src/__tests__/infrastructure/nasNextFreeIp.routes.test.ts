import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createNasRouter } from '@infrastructure/http/routes/nas.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
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
import { FindFreeIp } from '@application/use-cases/FindFreeIp';

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

  const readerRole = await roleRepo.create({ code: 'network_reader', label: 'Network Reader', isSystem: false });
  const readPerm   = await permRepo.seed({ moduleCode: 'network', action: 'read' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser   = await mkUser('reader');
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const nasRepo = new InMemoryNasRepository();
  const ipRepo = new InMemoryIpNetworkRepository();
  ipRepo.seedNetwork({
    id: 'net-cgnat',
    network: '100.64.10.0/24',
    gateway: '100.64.10.1',
    dns1: '', dns2: '', description: 'cgnat', partnerId: null,
    type: 'static', totalIps: 254, usedIps: 0, freeIps: 254,
  });
  ipRepo.seedPool({
    id: 'pool-cgnat',
    name: 'mercaccesosur-cgnat',
    networkId: 'net-cgnat',
    rangeStart: '100.64.10.2',
    rangeEnd: '100.64.10.5',
    type: 'dynamic', assignedCount: 0, totalCount: 4,
    nasId: '1', ipKind: 'cgnat',
  });
  const router = new InMemoryRouterGateway();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();

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
    new FindFreeIp(ipRepo, nasRepo, router, orchestrator),
  ));
  app.use(errorHandler);

  return { app, readUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('GET /api/nas/:nasId/next-free-ip — allocator endpoint', () => {
  it('sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).get('/api/nas/1/next-free-ip?type=cgnat')).status).toBe(401);
  });

  it('con auth pero sin network.read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/nas/1/next-free-ip?type=cgnat'), noPermUserId);
    expect(res.status).toBe(403);
  });

  it('con network.read → 200 + { ip }', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/nas/1/next-free-ip?type=cgnat'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ip: '100.64.10.2' });
  });

  it('tipo inválido → 400', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/nas/1/next-free-ip?type=banana'), readUserId);
    expect(res.status).toBe(400);
  });

  it('NAS sin pool de ese tipo → 404', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/nas/1/next-free-ip?type=public'), readUserId);
    expect(res.status).toBe(404);
  });

  it('NAS inexistente → 404', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/nas/999/next-free-ip?type=cgnat'), readUserId);
    expect(res.status).toBe(404);
  });
});

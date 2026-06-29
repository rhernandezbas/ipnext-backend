/**
 * ipNetwork.routes.test.ts — redes/pools/asignaciones de IP + guard de seguridad.
 *
 * /api/ip-* estaba SIN auth ni permiso (agujero; fix `network-routes-guard`) — incluyendo data
 * sensible (GET /ip-pools, GET /ip-assignments). `network.read` para listar; `network.manage` para mutar.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createIpNetworkRouter } from '@infrastructure/http/routes/ipNetwork.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { ListIpNetworks } from '@application/use-cases/ListIpNetworks';
import { CreateIpNetwork } from '@application/use-cases/CreateIpNetwork';
import { DeleteIpNetwork } from '@application/use-cases/DeleteIpNetwork';
import { ListIpPools } from '@application/use-cases/ListIpPools';
import { CreateIpPool } from '@application/use-cases/CreateIpPool';
import { ListPppoeAssignments } from '@application/use-cases/ListPppoeAssignments';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';

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

async function buildApp(deps?: {
  router?: InMemoryRouterGateway;
  orchestrator?: InMemoryRadiusOrchestratorGateway;
}): Promise<Fixture> {
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

  const repo = new InMemoryIpNetworkRepository();
  const nasRepo = new InMemoryNasRepository();
  const router = deps?.router ?? new InMemoryRouterGateway();
  const orchestrator = deps?.orchestrator ?? new InMemoryRadiusOrchestratorGateway();
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createIpNetworkRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new ListIpNetworks(repo, nasRepo, router, orchestrator),
    new CreateIpNetwork(repo),
    new DeleteIpNetwork(repo),
    new ListIpPools(repo, nasRepo, router, orchestrator),
    new CreateIpPool(repo),
    new ListPppoeAssignments(new InMemoryPppoeServiceRepository()),
  ));
  app.use(errorHandler);

  return { app, readUserId: readUser.id, manageUserId: manageUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('ipNetwork.routes — redes/pools + security guard (network.read / network.manage)', () => {
  it('GET /api/ip-networks sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).get('/api/ip-networks')).status).toBe(401);
  });
  it('GET /api/ip-pools sin network.read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    expect((await asUser(request(app).get('/api/ip-pools'), noPermUserId)).status).toBe(403);
  });
  it('GET /api/ip-networks con network.read → 200 con 2 redes', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/ip-networks'), readUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
  });
  it('GET /api/ip-pools con network.read → 200 con 3 pools', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/ip-pools'), readUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(3);
  });

  it('POST /api/ip-networks sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).post('/api/ip-networks').send({ name: 'x' })).status).toBe(401);
  });
  it('POST /api/ip-networks con solo network.read → 403', async () => {
    const { app, readUserId } = await buildApp();
    expect((await asUser(request(app).post('/api/ip-networks'), readUserId).send({ name: 'x' })).status).toBe(403);
  });
  it('POST /api/ip-networks con network.manage → 201', async () => {
    const { app, manageUserId } = await buildApp();
    const res = await asUser(request(app).post('/api/ip-networks'), manageUserId)
      .send({ name: 'Red Test', cidr: '10.9.0.0/24', gateway: '10.9.0.1', vlan: null, type: 'private' });
    expect(res.status).toBe(201);
  });

  // Seam HTTP (lección #28): el contador "no disponible" (null) debe sobrevivir la serialización
  // del endpoint. Si alguien introduce un mapper/DTO con `?? 0`, revive el bug del 0 mentiroso y
  // estos casos lo cazan. El pool/red seed '1' cuelga del NAS '1' (mikrotik_api 192.168.1.1) →
  // router caído ⇒ assignedCount/usedIps/freeIps null en el JSON de respuesta.
  it('GET /api/ip-pools con la fuente caída → assignedCount === null en el JSON (no 0)', async () => {
    const downRouter = new InMemoryRouterGateway({ unreachable: ['192.168.1.1'] });
    const { app, readUserId } = await buildApp({ router: downRouter });

    const res = await asUser(request(app).get('/api/ip-pools'), readUserId);

    expect(res.status).toBe(200);
    const pool1 = res.body.find((p: { id: string }) => p.id === '1'); // NAS '1' (router caído)
    expect(pool1.assignedCount).toBeNull();
    expect(pool1.totalCount).toBe(191); // el total del rango siempre se computa
  });

  it('GET /api/ip-networks con la fuente caída → usedIps/freeIps === null en el JSON (no 0)', async () => {
    const downRouter = new InMemoryRouterGateway({ unreachable: ['192.168.1.1'] });
    const { app, readUserId } = await buildApp({ router: downRouter });

    const res = await asUser(request(app).get('/api/ip-networks'), readUserId);

    expect(res.status).toBe(200);
    const net1 = res.body.find((n: { id: string }) => n.id === '1'); // cuelga del pool del NAS '1'
    expect(net1.usedIps).toBeNull();
    expect(net1.freeIps).toBeNull();
    expect(net1.totalIps).toBe(254); // el total del CIDR siempre se computa
  });
});

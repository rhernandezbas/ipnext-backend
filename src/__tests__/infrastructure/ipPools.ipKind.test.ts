/**
 * ipPools.ipKind.test.ts
 *
 * Task 5.1: verificar que ipKind viaja en la respuesta de GET /api/ip-pools.
 * Task 5.2: verificar que assignedCount === null se preserva (no se convierte a 0).
 *
 * Seam test: ruta real → use case real → InMemory repos.
 * Esto es un Verify-only si ipKind ya viaja (no toca código BE de pools).
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
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';

import { ListIpNetworks } from '@application/use-cases/ListIpNetworks';
import { CreateIpNetwork } from '@application/use-cases/CreateIpNetwork';
import { DeleteIpNetwork } from '@application/use-cases/DeleteIpNetwork';
import { ListIpPools } from '@application/use-cases/ListIpPools';
import { CreateIpPool } from '@application/use-cases/CreateIpPool';
import { ListPppoeAssignments } from '@application/use-cases/ListPppoeAssignments';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import type { IpPool } from '@domain/entities/network';

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

async function buildApp(opts?: { networkRepo?: InMemoryIpNetworkRepository; router?: InMemoryRouterGateway }) {
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

  const readerRole = await roleRepo.create({ code: 'ipkind_reader', label: 'IpKind Reader', isSystem: false });
  const readPerm   = await permRepo.seed({ moduleCode: 'network', action: 'read' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash  = await hasher.hash('pw');
  const mkUser  = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser = await mkUser('ipkind_reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const networkRepo  = opts?.networkRepo ?? new InMemoryIpNetworkRepository();
  const nasRepo      = new InMemoryNasRepository();
  const router       = opts?.router ?? new InMemoryRouterGateway();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const requirePerm  = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createIpNetworkRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new ListIpNetworks(networkRepo, nasRepo, router, orchestrator),
    new CreateIpNetwork(networkRepo),
    new DeleteIpNetwork(networkRepo),
    new ListIpPools(networkRepo, nasRepo, router, orchestrator),
    new CreateIpPool(networkRepo),
    new ListPppoeAssignments(new InMemoryPppoeServiceRepository()),
  ));
  app.use(errorHandler);

  return { app, readUserId: readUser.id, networkRepo };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ── Task 5.1: ipKind viaja en GET /api/ip-pools ───────────────────────────────

describe('GET /api/ip-pools — task 5.1: ipKind en el contrato', () => {
  it('cada pool del body tiene la propiedad ipKind', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/ip-pools'), readUserId);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Cada pool debe exponer ipKind (cgnat | public | null)
    res.body.forEach((pool: any) => {
      expect('ipKind' in pool).toBe(true);
      expect(pool.ipKind === 'cgnat' || pool.ipKind === 'public' || pool.ipKind === null).toBe(true);
    });
  });

  it('pool con ipKind=null en el seed → llega null en el JSON (no undefined)', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/ip-pools'), readUserId);

    // El seed del InMemoryIpNetworkRepository tiene todos los pools con ipKind: null
    expect(res.status).toBe(200);
    const poolsWithNull = res.body.filter((p: any) => p.ipKind === null);
    expect(poolsWithNull.length).toBeGreaterThan(0);
  });

  it('pool con ipKind=cgnat en el seed → llega cgnat en el JSON', async () => {
    const networkRepo = new InMemoryIpNetworkRepository();
    // Sembramos un pool extra con ipKind=cgnat
    networkRepo.seedPool({
      id: 'p-cgnat',
      name: 'cgnat-pool',
      networkId: '1',
      rangeStart: '100.64.0.1',
      rangeEnd: '100.64.0.100',
      type: 'dynamic',
      assignedCount: 10,
      totalCount: 100,
      nasId: null,
      ipKind: 'cgnat',
    });

    const { app, readUserId } = await buildApp({ networkRepo });
    const res = await asUser(request(app).get('/api/ip-pools'), readUserId);

    expect(res.status).toBe(200);
    const cgnatPool = res.body.find((p: any) => p.id === 'p-cgnat');
    expect(cgnatPool).toBeDefined();
    expect(cgnatPool.ipKind).toBe('cgnat');
  });

  it('pool con ipKind=public en el seed → llega public en el JSON', async () => {
    const networkRepo = new InMemoryIpNetworkRepository();
    networkRepo.seedPool({
      id: 'p-public',
      name: 'public-pool',
      networkId: '1',
      rangeStart: '200.110.180.1',
      rangeEnd: '200.110.180.100',
      type: 'dynamic',
      assignedCount: 5,
      totalCount: 100,
      nasId: null,
      ipKind: 'public',
    });

    const { app, readUserId } = await buildApp({ networkRepo });
    const res = await asUser(request(app).get('/api/ip-pools'), readUserId);

    expect(res.status).toBe(200);
    const pubPool = res.body.find((p: any) => p.id === 'p-public');
    expect(pubPool).toBeDefined();
    expect(pubPool.ipKind).toBe('public');
  });
});

// ── Task 5.2: assignedCount null se preserva ─────────────────────────────────

describe('GET /api/ip-pools — task 5.2: assignedCount null se preserva', () => {
  it('con NAS caído → assignedCount === null en el JSON (no 0, no undefined)', async () => {
    const downRouter = new InMemoryRouterGateway({ unreachable: ['192.168.1.1'] });
    const { app, readUserId } = await buildApp({ router: downRouter });

    const res = await asUser(request(app).get('/api/ip-pools'), readUserId);

    expect(res.status).toBe(200);
    // Pool '1' cuelga del NAS '1' (192.168.1.1 → router caído)
    const pool1 = res.body.find((p: IpPool) => p.id === '1');
    expect(pool1).toBeDefined();
    expect(pool1.assignedCount).toBeNull();  // NUNCA null→0
  });

  it('ipKind=null con NAS caído → ambos campos null, independientes', async () => {
    const downRouter = new InMemoryRouterGateway({ unreachable: ['192.168.1.1'] });
    const { app, readUserId } = await buildApp({ router: downRouter });

    const res = await asUser(request(app).get('/api/ip-pools'), readUserId);

    expect(res.status).toBe(200);
    const pool1 = res.body.find((p: any) => p.id === '1');
    // Los dos null son independientes: assignedCount=null (NAS caído), ipKind=null (legacy)
    expect(pool1.assignedCount).toBeNull();
    expect(pool1.ipKind).toBeNull();
  });
});

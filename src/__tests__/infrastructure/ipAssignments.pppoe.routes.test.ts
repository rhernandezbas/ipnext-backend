/**
 * ipAssignments.pppoe.routes.test.ts — Bug 3: GET /api/ip-assignments usa ListPppoeAssignments.
 *
 * Seam test: ruta → use case real → in-memory repo (supertest). No se mockea el use case.
 * Verifica:
 *   - 401 sin auth
 *   - 403 sin network.read
 *   - 200 con lista de PppoeAssignmentDto (solo los asignados: contractId+IP+enabled)
 *   - El DTO tiene el shape exacto del contrato FE (ip, username, contractId, etc.)
 *   - Los huérfanos y sin-IP NO aparecen en el resultado
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
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
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

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

const NAS_ID = 'nas-1';

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
  pppoeRepo: InMemoryPppoeServiceRepository;
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

  const readerRole  = await roleRepo.create({ code: 'network_reader', label: 'Network Reader', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'network', action: 'read' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser   = await mkUser('reader');
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const ipRepo      = new InMemoryIpNetworkRepository();
  const nasRepo     = new InMemoryNasRepository();
  const routerGw    = new InMemoryRouterGateway();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const pppoeRepo   = new InMemoryPppoeServiceRepository();

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createIpNetworkRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new ListIpNetworks(ipRepo, nasRepo, routerGw, orchestrator),
    new CreateIpNetwork(ipRepo),
    new DeleteIpNetwork(ipRepo),
    new ListIpPools(ipRepo, nasRepo, routerGw, orchestrator),
    new CreateIpPool(ipRepo),
    new ListPppoeAssignments(pppoeRepo),  // Bug 3: nuevo use case en lugar de ListIpAssignments
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, readUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('GET /api/ip-assignments — Bug 3: datos de PppoeService (Asignaciones tab)', () => {
  it('sin auth → 401', async () => {
    const { app } = await buildApp();
    expect((await request(app).get('/api/ip-assignments')).status).toBe(401);
  });

  it('sin network.read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    expect((await asUser(request(app).get('/api/ip-assignments'), noPermUserId)).status).toBe(403);
  });

  it('lista vacía cuando no hay asignados → 200 []', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/ip-assignments'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('retorna solo asignados (contractId+IP+enabled) en forma de PppoeAssignmentDto', async () => {
    const { app, pppoeRepo, readUserId } = await buildApp();

    // Asignado correcto — debe aparecer
    const s = await pppoeRepo.upsertByUsername({
      username: 'juanperez',
      password: 'secret',
      nasId: NAS_ID,
      contractId: 'contract-42',
      remoteAddress: '100.64.10.10',
      status: 'enabled',
      profile: 'IP-Air-30-10',
    });

    // Huérfano — NO debe aparecer
    await pppoeRepo.upsertByUsername({
      username: 'orphan', password: 'p', nasId: NAS_ID,
      contractId: null, remoteAddress: '10.0.0.2', status: 'enabled',
    });

    // Sin IP — NO debe aparecer
    await pppoeRepo.upsertByUsername({
      username: 'no-ip', password: 'p', nasId: NAS_ID,
      contractId: 'C2', remoteAddress: null, status: 'enabled',
    });

    const res = await asUser(request(app).get('/api/ip-assignments'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const dto = res.body[0];
    // Shape exacto del contrato FE
    expect(dto.id).toBe(s.id);
    expect(dto.ip).toBe('100.64.10.10');
    expect(dto.username).toBe('juanperez');
    expect(dto.contractId).toBe('contract-42');
    expect(dto.profile).toBe('IP-Air-30-10');
    expect(dto.nasId).toBe(NAS_ID);
    expect(dto.status).toBe('enabled');
    expect(typeof dto.createdAt).toBe('string');

    // password NUNCA en respuesta
    expect(dto.password).toBeUndefined();
  });

  it('múltiples asignados → todos aparecen', async () => {
    const { app, pppoeRepo, readUserId } = await buildApp();
    await pppoeRepo.upsertByUsername({ username: 'u1', password: 'p', nasId: NAS_ID, contractId: 'C1', remoteAddress: '10.0.0.1', status: 'enabled' });
    await pppoeRepo.upsertByUsername({ username: 'u2', password: 'p', nasId: NAS_ID, contractId: 'C2', remoteAddress: '10.0.0.2', status: 'enabled' });
    const res = await asUser(request(app).get('/api/ip-assignments'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

/**
 * ipAssignments.paginated.routes.test.ts — seam test for paginated GET /api/ip-assignments.
 *
 * No use-case mocking: real ListPppoeAssignments → real InMemoryPppoeServiceRepository.
 * Validates the response contract: { data, total, page, pageSize } and query-param handling.
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

async function buildApp() {
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
  const readUser = await userRepo.create({
    name: 'reader', email: 'reader@x.com', login: 'reader', passwordHash: pwHash, status: 'active',
  });
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const ipRepo       = new InMemoryIpNetworkRepository();
  const nasRepo      = new InMemoryNasRepository();
  const routerGw     = new InMemoryRouterGateway();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const pppoeRepo    = new InMemoryPppoeServiceRepository();

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
    new ListPppoeAssignments(pppoeRepo),
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, readUserId: readUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('GET /api/ip-assignments — paginated route seam', () => {
  it('returns { data, total, page, pageSize } shape with defaults (page=1, pageSize=25)', async () => {
    const { app, pppoeRepo, readUserId } = await buildApp();

    for (let i = 1; i <= 5; i++) {
      await pppoeRepo.upsertByUsername({
        username: `user${i}`, password: 'p', nasId: NAS_ID,
        contractId: `c${i}`, remoteAddress: `10.0.0.${i}`, status: 'enabled',
      });
    }

    const res = await asUser(request(app).get('/api/ip-assignments'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('page');
    expect(res.body).toHaveProperty('pageSize');
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(25);
    expect(res.body.total).toBe(5);
    expect(res.body.data).toHaveLength(5);
  });

  it('respects page and pageSize query params', async () => {
    const { app, pppoeRepo, readUserId } = await buildApp();

    // seed 30 items
    for (let i = 1; i <= 30; i++) {
      await pppoeRepo.upsertByUsername({
        username: `usr${String(i).padStart(3, '0')}`, password: 'p', nasId: NAS_ID,
        contractId: `c${i}`, remoteAddress: `10.0.${Math.floor(i / 256)}.${i % 256}`, status: 'enabled',
      });
    }

    const res = await asUser(
      request(app).get('/api/ip-assignments?page=2&pageSize=10'),
      readUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.total).toBe(30);
    expect(res.body.data).toHaveLength(10);
    // page 2 of size 10 = items 11-20 (alphabetical by username)
    expect(res.body.data[0].username).toBe('usr011');
  });

  it('search query param filters results', async () => {
    const { app, pppoeRepo, readUserId } = await buildApp();
    await pppoeRepo.upsertByUsername({
      username: 'juan', password: 'p', nasId: NAS_ID,
      contractId: 'c-juan', remoteAddress: '10.0.0.1', status: 'enabled',
    });
    await pppoeRepo.upsertByUsername({
      username: 'pedro', password: 'p', nasId: NAS_ID,
      contractId: 'c-pedro', remoteAddress: '10.0.0.2', status: 'enabled',
    });

    const res = await asUser(
      request(app).get('/api/ip-assignments?search=juan'),
      readUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].username).toBe('juan');
  });

  it('nasId query param filters results', async () => {
    const { app, pppoeRepo, readUserId } = await buildApp();
    await pppoeRepo.upsertByUsername({
      username: 'a', password: 'p', nasId: 'nas-x',
      contractId: 'cx', remoteAddress: '10.0.0.1', status: 'enabled',
    });
    await pppoeRepo.upsertByUsername({
      username: 'b', password: 'p', nasId: 'nas-y',
      contractId: 'cy', remoteAddress: '10.0.0.2', status: 'enabled',
    });

    const res = await asUser(
      request(app).get('/api/ip-assignments?nasId=nas-x'),
      readUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].nasId).toBe('nas-x');
  });

  it('page=2&pageSize=10&search=x&nasId=y — combined params honored', async () => {
    const { app, pppoeRepo, readUserId } = await buildApp();

    const nasId = 'nas-target';
    // seed 25 items with 'xuser' in username on nasId
    for (let i = 1; i <= 25; i++) {
      await pppoeRepo.upsertByUsername({
        username: `xuser${String(i).padStart(2, '0')}`, password: 'p', nasId,
        contractId: `cx${i}`, remoteAddress: `192.168.1.${i}`, status: 'enabled',
      });
    }
    // Add non-matching items
    await pppoeRepo.upsertByUsername({
      username: 'other', password: 'p', nasId: 'other-nas',
      contractId: 'co', remoteAddress: '1.1.1.1', status: 'enabled',
    });

    const res = await asUser(
      request(app).get(`/api/ip-assignments?page=2&pageSize=10&search=xuser&nasId=${nasId}`),
      readUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.total).toBe(25);
    expect(res.body.data).toHaveLength(10);
    res.body.data.forEach((d: any) => {
      expect(d.nasId).toBe(nasId);
      expect(d.username).toContain('xuser');
    });
  });

  it('clamps pageSize to max 200', async () => {
    const { app, pppoeRepo, readUserId } = await buildApp();
    await pppoeRepo.upsertByUsername({
      username: 'u1', password: 'p', nasId: NAS_ID,
      contractId: 'c1', remoteAddress: '10.0.0.1', status: 'enabled',
    });

    const res = await asUser(
      request(app).get('/api/ip-assignments?pageSize=9999'),
      readUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(200);
  });

  it('clamps pageSize to min 1', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(
      request(app).get('/api/ip-assignments?pageSize=0'),
      readUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(1);
  });

  it('clamps page to min 1', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(
      request(app).get('/api/ip-assignments?page=-5'),
      readUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
  });

  it('data items have the PppoeAssignmentDto shape (ip alias, no password)', async () => {
    const { app, pppoeRepo, readUserId } = await buildApp();
    await pppoeRepo.upsertByUsername({
      username: 'juan', password: 'secret', nasId: NAS_ID,
      contractId: 'c-juan', remoteAddress: '100.64.10.10', status: 'enabled',
      profile: 'plan-30',
    });

    const res = await asUser(request(app).get('/api/ip-assignments'), readUserId);
    expect(res.status).toBe(200);
    const dto = res.body.data[0];
    expect(typeof dto.id).toBe('string');
    expect(dto.ip).toBe('100.64.10.10');
    expect(dto.username).toBe('juan');
    expect(dto.contractId).toBe('c-juan');
    expect(dto.nasId).toBe(NAS_ID);
    expect(dto.status).toBe('enabled');
    expect(dto.profile).toBe('plan-30');
    expect(typeof dto.createdAt).toBe('string');
    expect(dto.password).toBeUndefined();
  });

  it('empty repo → { data: [], total: 0, page: 1, pageSize: 25 }', async () => {
    const { app, readUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/ip-assignments'), readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 0, page: 1, pageSize: 25 });
  });
});

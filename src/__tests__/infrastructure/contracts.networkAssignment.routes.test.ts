/**
 * PATCH /api/contracts/:id/network-assignment — PICK-3. Picker manual del nodo/AP.
 * Gate: contracts.assign. Patrón EXACTO de contractLocation.routes.test.ts
 * (PATCH /contracts/:id/location) — mismo fixture, mismo estilo.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createContractsRouter } from '@infrastructure/http/routes/contracts.routes';
import { SetContractNetworkAssignment } from '@application/use-cases/SetContractNetworkAssignment';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { InMemoryNetworkSiteRepository } from '@infrastructure/adapters/in-memory/InMemoryNetworkSiteRepository';
import { InMemoryAccessPointRepository } from '@infrastructure/adapters/in-memory/InMemoryAccessPointRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
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
  contractRepo: InMemoryContractRepository;
  accessPointRepo: InMemoryAccessPointRepository;
  assignUserId: string;
  noPermUserId: string;
  contractId: string;
}

async function buildApp(opts: { withUseCase?: boolean } = {}): Promise<Fixture> {
  const withUseCase = opts.withUseCase ?? true;

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

  const assignRole = await roleRepo.create({ code: 'net_assigner', label: 'Net Assigner', isSystem: false });
  const noPermRole = await roleRepo.create({ code: 'net_none', label: 'Net None', isSystem: false });
  const assignPerm = await permRepo.seed({ moduleCode: 'contracts', action: 'assign' });
  await rolePermRepo.grant(assignRole.id, assignPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const assignUser = await mkUser('assigner');
  await userRoleRepo.assign(assignUser.id, assignRole.id);
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(noPermUser.id, noPermRole.id);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const contractRepo = new InMemoryContractRepository();
  const networkSiteRepo = new InMemoryNetworkSiteRepository();
  const accessPointRepo = new InMemoryAccessPointRepository();
  const seeded = contractRepo.seed({ clientName: 'Alice', plan: 'Plan 50', status: 'active' });

  const setContractNetworkAssignment = withUseCase
    ? new SetContractNetworkAssignment(contractRepo, networkSiteRepo, accessPointRepo)
    : undefined;

  const listContracts = { execute: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 }) } as any;
  const getContractStats = { execute: jest.fn().mockResolvedValue({ total: 0, byStatus: {} }) } as any;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createContractsRouter(
    new EchoAuthProvider() as any,
    undefined,
    listContracts, getContractStats,
    undefined, requirePerm, setContractNetworkAssignment,
  ));
  app.use(errorHandler);

  return { app, contractRepo, accessPointRepo, assignUserId: assignUser.id, noPermUserId: noPermUser.id, contractId: seeded.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('PATCH /api/contracts/:id/network-assignment', () => {
  it('contracts.assign + accessPointId válido → 200 { id, networkSiteId, accessPointId }', async () => {
    const { app, accessPointRepo, assignUserId, contractId } = await buildApp();
    const ap1 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-1', networkSiteId: '1', name: 'AP1', mac: null });

    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/network-assignment`).send({ accessPointId: ap1.id }),
      assignUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: contractId, networkSiteId: '1', accessPointId: ap1.id });
  });

  it('body vacío ({}) → 400 VALIDATION_ERROR', async () => {
    const { app, assignUserId, contractId } = await buildApp();

    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/network-assignment`).send({}),
      assignUserId,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('key desconocida en el body → 400 VALIDATION_ERROR (whitelist zod)', async () => {
    const { app, assignUserId, contractId } = await buildApp();

    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/network-assignment`).send({ notAField: 'x' }),
      assignUserId,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('contrato inexistente → 404 CONTRACT_NOT_FOUND', async () => {
    const { app, assignUserId } = await buildApp();

    const res = await asUser(
      request(app).patch('/api/contracts/no-such-contract/network-assignment').send({ networkSiteId: null }),
      assignUserId,
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('networkSiteId inexistente → 422 NETWORK_SITE_NOT_FOUND', async () => {
    const { app, assignUserId, contractId } = await buildApp();

    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/network-assignment`).send({ networkSiteId: 'no-such-site' }),
      assignUserId,
    );

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NETWORK_SITE_NOT_FOUND');
  });

  it('accessPointId inexistente → 422 ACCESS_POINT_NOT_FOUND', async () => {
    const { app, assignUserId, contractId } = await buildApp();

    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/network-assignment`).send({ accessPointId: 'no-such-ap' }),
      assignUserId,
    );

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ACCESS_POINT_NOT_FOUND');
  });

  it('AP retirado → 422 ACCESS_POINT_RETIRED', async () => {
    const { app, accessPointRepo, assignUserId, contractId } = await buildApp();
    const ap9 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-9', networkSiteId: '1', name: 'AP retirado', mac: null });
    await accessPointRepo.markMissing(['dev-9'], new Date('2026-01-01T00:00:00Z'));

    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/network-assignment`).send({ accessPointId: ap9.id }),
      assignUserId,
    );

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ACCESS_POINT_RETIRED');
  });

  it('AP de otro nodo → 422 ACCESS_POINT_NOT_IN_SITE', async () => {
    const { app, accessPointRepo, assignUserId, contractId } = await buildApp();
    const ap1 = await accessPointRepo.upsertByUispDeviceId({ uispDeviceId: 'dev-1', networkSiteId: '1', name: 'AP1', mac: null });

    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/network-assignment`).send({ networkSiteId: '2', accessPointId: ap1.id }),
      assignUserId,
    );

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ACCESS_POINT_NOT_IN_SITE');
  });

  it('sin contracts.assign → 403', async () => {
    const { app, noPermUserId, contractId } = await buildApp();

    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/network-assignment`).send({ networkSiteId: null }),
      noPermUserId,
    );

    expect(res.status).toBe(403);
  });

  it('sin autenticar → 401', async () => {
    const { app, contractId } = await buildApp();

    const res = await request(app).patch(`/api/contracts/${contractId}/network-assignment`).send({ networkSiteId: null });

    expect(res.status).toBe(401);
  });

  it('sin la dependencia inyectada → 501 NOT_IMPLEMENTED', async () => {
    const { app, assignUserId, contractId } = await buildApp({ withUseCase: false });

    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/network-assignment`).send({ networkSiteId: null }),
      assignUserId,
    );

    expect(res.status).toBe(501);
    expect(res.body.code).toBe('NOT_IMPLEMENTED');
  });
});

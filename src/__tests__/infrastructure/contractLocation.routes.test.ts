/**
 * TDD: PATCH /api/contracts/:id/location — UpdateContractLocation route tests.
 * Uses in-memory repos + requirePermission for full gate verification.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createContractsRouter } from '@infrastructure/http/routes/contracts.routes';
import { UpdateContractLocation } from '@application/use-cases/UpdateContractLocation';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
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
  writeUserId: string;
  readOnlyUserId: string;
  contractId: string;
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

  const writeRole  = await roleRepo.create({ code: 'cli_writer', label: 'Cli Writer', isSystem: false });
  const readerRole = await roleRepo.create({ code: 'cli_reader', label: 'Cli Reader', isSystem: false });

  const writePerm = await permRepo.seed({ moduleCode: 'clients', action: 'write' });
  const readPerm  = await permRepo.seed({ moduleCode: 'clients', action: 'read' });

  await rolePermRepo.grant(writeRole.id, writePerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const writeUser = await mkUser('writer');
  await userRoleRepo.assign(writeUser.id, writeRole.id);
  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);
  const contractRepo = new InMemoryContractRepository();

  // Seed one contract so we can test valid + not-found
  const seeded = contractRepo.seed({ clientName: 'Alice', plan: 'Plan 50', status: 'active' });

  const updateContractLocation = new UpdateContractLocation(contractRepo);
  const listContracts = { execute: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 }) } as any;
  const getContractStats = { execute: jest.fn().mockResolvedValue({ total: 0, byStatus: {} }) } as any;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createContractsRouter(
    new EchoAuthProvider() as any,
    undefined,
    listContracts, getContractStats,
    updateContractLocation, requirePerm,
  ));
  app.use(errorHandler);

  return { app, contractRepo, writeUserId: writeUser.id, readOnlyUserId: readUser.id, contractId: seeded.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('PATCH /api/contracts/:id/location — UpdateContractLocation', () => {
  it('clients.write → 200 with updated GPS fields', async () => {
    const { app, writeUserId, contractId } = await buildApp();
    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/location`).send({ gpsLat: -34.6, gpsLng: -58.38, gpsPlusCode: '48Q9+CF' }),
      writeUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(contractId);
    expect(res.body.gpsLat).toBe(-34.6);
    expect(res.body.gpsLng).toBe(-58.38);
    expect(res.body.gpsPlusCode).toBe('48Q9+CF');
  });

  it('null clears GPS fields', async () => {
    const { app, writeUserId, contractId } = await buildApp();
    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/location`).send({ gpsLat: null, gpsLng: null, gpsPlusCode: null }),
      writeUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.gpsLat).toBeNull();
  });

  it('unknown contract id → 404', async () => {
    const { app, writeUserId } = await buildApp();
    const res = await asUser(
      request(app).patch('/api/contracts/nonexistent/location').send({ gpsLat: 0, gpsLng: 0 }),
      writeUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('gpsLat out of range → 400 (Zod) or 422 (use case validation)', async () => {
    const { app, writeUserId, contractId } = await buildApp();
    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/location`).send({ gpsLat: 999 }),
      writeUserId,
    );
    expect([400, 422]).toContain(res.status);
  });

  it('without clients.write → 403', async () => {
    const { app, readOnlyUserId, contractId } = await buildApp();
    const res = await asUser(
      request(app).patch(`/api/contracts/${contractId}/location`).send({ gpsLat: 0 }),
      readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });

  it('whitelist: GR field "lat" in body does NOT change contract GPS (only gps* fields read)', async () => {
    const { app, writeUserId, contractId, contractRepo } = await buildApp();

    // Spy on updateLocation to verify only gps* fields are passed
    const spy = jest.spyOn(contractRepo, 'updateLocation');

    await asUser(
      request(app).patch(`/api/contracts/${contractId}/location`).send({
        gpsLat: -34.6,
        gpsLng: -58.38,
        lat: 99.99,       // GR field — must be stripped by Zod
        lng: 99.99,       // GR field — must be stripped by Zod
      }),
      writeUserId,
    );

    // The call to updateLocation must not include lat/lng (GR fields)
    expect(spy).toHaveBeenCalled();
    const callData = spy.mock.calls[0][1];
    expect(callData).not.toHaveProperty('lat');
    expect(callData).not.toHaveProperty('lng');
  });

  it('unauthenticated → 401', async () => {
    const { app, contractId } = await buildApp();
    const res = await request(app).patch(`/api/contracts/${contractId}/location`).send({ gpsLat: 0 });
    expect(res.status).toBe(401);
  });
});

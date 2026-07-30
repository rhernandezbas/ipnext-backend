/**
 * TDD: PATCH /api/clients/:id — UpdateClientLocation route tests.
 * Uses in-memory repos + requirePermission for full gate verification.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createClientsRouter } from '@infrastructure/http/routes/clients.routes';
import { UpdateClientLocation } from '@application/use-cases/UpdateClientLocation';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';

import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Customer } from '@domain/entities/customer';
import { ClientNotFoundError } from '@domain/errors';
import { InvalidLocationError } from '@domain/errors/geolocation';
import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

const BASE_CUSTOMER: Customer = {
  id: 'c1',
  name: 'Alice',
  email: 'alice@test.com',
  phone: '111',
  status: 'active',
  address: 'Calle 1',
  city: 'BA',
  country: 'AR',
  login: 'alice',
  createdAt: '2026-01-01T00:00:00.000Z',
  lat: null,
  lng: null,
  plusCode: null,
};

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

function makeCustomerRepo(overrides: Partial<CustomerRepository> = {}): CustomerRepository {
  return {
    list: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 }),
    findById: jest.fn().mockResolvedValue(BASE_CUSTOMER),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn().mockResolvedValue({ total: 0, active: 0, inactive: 0, blocked: 0, late: 0, baja: 0 }),
    listContracts: jest.fn().mockResolvedValue([]),
    listInvoices: jest.fn().mockResolvedValue([]),
    listLogs: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 }),
    updateLocation: jest.fn().mockResolvedValue({ ...BASE_CUSTOMER, lat: -34.6, lng: -58.38, plusCode: '48Q9+CF' }),
    listActiveContacts: jest.fn().mockResolvedValue([]),
    getPortalBalanceSummary: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

interface Fixture {
  app: express.Express;
  writeUserId: string;
  readOnlyUserId: string;
  customerRepo: CustomerRepository;
}

async function buildApp(customerRepoOverrides: Partial<CustomerRepository> = {}): Promise<Fixture> {
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
  const customerRepo = makeCustomerRepo(customerRepoOverrides);
  const updateClientLocation = new UpdateClientLocation(customerRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  // Minimal stub use cases that are not under test
  const listClients = { execute: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 }) } as any;
  const getDetail   = { execute: jest.fn().mockResolvedValue(BASE_CUSTOMER) } as any;
  const getContracts = { execute: jest.fn().mockResolvedValue([]) } as any;
  const getInvoices  = { execute: jest.fn().mockResolvedValue([]) } as any;
  const getLogs      = { execute: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 25 }) } as any;
  const createCustomer = { execute: jest.fn() } as any;
  const getStats = { execute: jest.fn().mockResolvedValue({ total: 0, active: 0, inactive: 0, blocked: 0, late: 0, baja: 0 }) } as any;
  const deleteCustomer = { execute: jest.fn() } as any;

  app.use('/api/clients', createClientsRouter(
    listClients, getDetail, getContracts, getInvoices, getLogs,
    new EchoAuthProvider() as any,
    createCustomer, getStats, deleteCustomer,
    updateClientLocation, requirePerm,
  ));
  app.use(errorHandler);

  return { app, writeUserId: writeUser.id, readOnlyUserId: readUser.id, customerRepo };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('PATCH /api/clients/:id — UpdateClientLocation', () => {
  it('clients.write → 200 with updated GPS fields', async () => {
    const { app, writeUserId } = await buildApp();
    const res = await asUser(request(app).patch('/api/clients/c1').send({ lat: -34.6, lng: -58.38, plusCode: '48Q9+CF' }), writeUserId);

    expect(res.status).toBe(200);
    expect(res.body.lat).toBe(-34.6);
    expect(res.body.lng).toBe(-58.38);
    expect(res.body.plusCode).toBe('48Q9+CF');
  });

  it('null body clears GPS (returns null fields)', async () => {
    const { app, writeUserId } = await buildApp({
      updateLocation: jest.fn().mockResolvedValue({ ...BASE_CUSTOMER, lat: null, lng: null, plusCode: null }),
    });
    const res = await asUser(request(app).patch('/api/clients/c1').send({ lat: null, lng: null, plusCode: null }), writeUserId);

    expect(res.status).toBe(200);
    expect(res.body.lat).toBeNull();
  });

  it('unknown id → 404', async () => {
    const { app, writeUserId } = await buildApp({
      updateLocation: jest.fn().mockResolvedValue(null),
    });
    const res = await asUser(request(app).patch('/api/clients/nonexistent').send({ lat: 0, lng: 0 }), writeUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
  });

  it('lat out of range → 422', async () => {
    const { app, writeUserId } = await buildApp({
      updateLocation: jest.fn().mockRejectedValue(new InvalidLocationError('lat out of range')),
    });
    const res = await asUser(request(app).patch('/api/clients/c1').send({ lat: 999 }), writeUserId);
    // Zod catches lat > 90 first (schema level), returns 400; or use-case catches it → 422.
    // Both are acceptable as validation errors. Accept either:
    expect([400, 422]).toContain(res.status);
  });

  it('without clients.write → 403', async () => {
    const { app, readOnlyUserId } = await buildApp();
    const res = await asUser(request(app).patch('/api/clients/c1').send({ lat: 0, lng: 0 }), readOnlyUserId);
    expect(res.status).toBe(403);
  });

  it('whitelist: GR field "name" in body does NOT change customer (only GPS fields read)', async () => {
    const { app, writeUserId, customerRepo } = await buildApp();
    await asUser(request(app).patch('/api/clients/c1').send({ lat: -34.6, lng: -58.38, name: 'Hacker Name' }), writeUserId);
    // updateLocation should only have been called with GPS fields (name is stripped by Zod)
    expect(customerRepo.updateLocation).toHaveBeenCalledWith('c1', expect.objectContaining({
      lat: -34.6,
      lng: -58.38,
    }));
    // "name" should NOT appear in the updateLocation call
    const callArgs = (customerRepo.updateLocation as jest.Mock).mock.calls[0][1];
    expect(callArgs).not.toHaveProperty('name');
  });

  it('unauthenticated → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).patch('/api/clients/c1').send({ lat: 0 });
    expect(res.status).toBe(401);
  });
});

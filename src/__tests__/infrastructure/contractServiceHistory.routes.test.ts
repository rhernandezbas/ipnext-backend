/**
 * #73 — GET /contracts/:contractId/service-history route tests.
 * Supertest + in-memory repos; RBAC: clients.read. Validates:
 *   - 200 with history array for authorized user
 *   - tvPassword never in response; tvLogin IS present when set
 *   - 401 unauthenticated
 *   - 403 without clients.read permission
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createContractServicesRouter } from '@infrastructure/http/routes/contractServices.routes';

import { UpdateContractName } from '@application/use-cases/UpdateContractName';
import { AddContractService } from '@application/use-cases/AddContractService';
import { UpdateContractService } from '@application/use-cases/UpdateContractService';
import { RemoveContractService } from '@application/use-cases/RemoveContractService';
import { ListContractServiceHistory } from '@application/use-cases/ListContractServiceHistory';

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
  catalogRepo: InMemoryServiceCatalogRepository;
  csRepo: InMemoryContractServiceRepository;
  contractRepo: InMemoryContractRepository;
  contracts: Set<string>;
  writeUserId: string;
  readOnlyUserId: string;
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

  const writeRole  = await roleRepo.create({ code: 'cli_writer', label: 'Cli Writer', isSystem: false });
  const readerRole = await roleRepo.create({ code: 'cli_reader', label: 'Cli Reader', isSystem: false });
  const noPermRole = await roleRepo.create({ code: 'noperm', label: 'No Perm', isSystem: false });

  const writePerm = await permRepo.seed({ moduleCode: 'clients', action: 'write' });
  const readPerm  = await permRepo.seed({ moduleCode: 'clients', action: 'read' });

  await rolePermRepo.grant(writeRole.id, writePerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const writeUser  = await mkUser('writer');
  await userRoleRepo.assign(writeUser.id, writeRole.id);
  const readUser   = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(noPermUser.id, noPermRole.id);

  const catalogRepo  = new InMemoryServiceCatalogRepository();
  const csRepo       = new InMemoryContractServiceRepository();
  const contractRepo = new InMemoryContractRepository();
  const contracts    = new Set<string>();
  const contractLookup = { findById: async (id: string) => (contracts.has(id) ? { id } : null) };

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createContractServicesRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new UpdateContractName(contractRepo),
    new AddContractService(csRepo, catalogRepo, contractLookup),
    new UpdateContractService(csRepo),
    new RemoveContractService(csRepo),
    new ListContractServiceHistory(csRepo),
  ));
  app.use(errorHandler);

  return { app, catalogRepo, csRepo, contractRepo, contracts, writeUserId: writeUser.id, readOnlyUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedCatalog(fx: Fixture, name: string, active = true) {
  const cat = await fx.catalogRepo.create({ name, label: name, active, sortOrder: 0 });
  fx.csRepo.catalog[cat.id] = { name: cat.name, label: cat.label };
  return cat;
}

describe('GET /api/contracts/:contractId/service-history', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // SH-1: clients.read → 200 with history array
  it('clients.read → 200 with history array (active + inactive)', async () => {
    fx.contracts.add('C');
    const cat1 = await seedCatalog(fx, 'INTERNET');
    const cat2 = await seedCatalog(fx, 'TV');
    const active = await fx.csRepo.add({ contractId: 'C', serviceCatalogId: cat1.id });
    const row2   = await fx.csRepo.add({ contractId: 'C', serviceCatalogId: cat2.id });
    await fx.csRepo.update(row2.id, { status: 'inactive' });

    const res = await asUser(request(fx.app).get('/api/contracts/C/service-history'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(active.id);
    expect(ids).toContain(row2.id);
  });

  // SH-2: tvPassword never in response
  it('tvPassword is NEVER in the response', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'TV');
    await fx.csRepo.add({ contractId: 'C', serviceCatalogId: cat.id, tvLogin: 'GIGA001', tvPassword: 'secret99' });

    const res = await asUser(request(fx.app).get('/api/contracts/C/service-history'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body[0]).not.toHaveProperty('tvPassword');
    expect(JSON.stringify(res.body)).not.toContain('secret99');
  });

  // SH-3: tvLogin IS present when set
  it('tvLogin is present in item when set', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'TV');
    await fx.csRepo.add({ contractId: 'C', serviceCatalogId: cat.id, tvLogin: 'GIGA001', tvPassword: 'secret99' });

    const res = await asUser(request(fx.app).get('/api/contracts/C/service-history'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body[0].tvLogin).toBe('GIGA001');
  });

  // SH-4: 401 unauthenticated
  it('returns 401 when not authenticated', async () => {
    const res = await request(fx.app).get('/api/contracts/C/service-history');
    expect(res.status).toBe(401);
  });

  // SH-5: 403 without clients.read
  it('returns 403 when user has no clients.read permission', async () => {
    const res = await asUser(request(fx.app).get('/api/contracts/C/service-history'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  // SH-6: empty array for contract with no services
  it('returns empty array for a contract with no services', async () => {
    const res = await asUser(request(fx.app).get('/api/contracts/EMPTY/service-history'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  // SH-7: inactive row has deactivatedAt set
  it('inactive row has deactivatedAt set', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    const row = await fx.csRepo.add({ contractId: 'C', serviceCatalogId: cat.id });
    await fx.csRepo.update(row.id, { status: 'inactive' });

    const res = await asUser(request(fx.app).get('/api/contracts/C/service-history'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body[0].deactivatedAt).not.toBeNull();
  });

  // SH-8: existing contractServices.routes tests still work (clients.write can write)
  it('clients.write can still POST services (existing route not broken)', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    const res = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.writeUserId,
    );
    expect(res.status).toBe(201);
  });
});

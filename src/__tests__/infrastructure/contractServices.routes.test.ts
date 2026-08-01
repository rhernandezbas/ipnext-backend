/**
 * #43 — seam tests for contractServices.routes.ts.
 * Supertest + in-memory repos; status + body field-by-field per CSV/CN scenarios; 403 by permission.
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

  return { app, catalogRepo, csRepo, contractRepo, contracts, writeUserId: writeUser.id, readOnlyUserId: readUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// Helper: seed a catalog entry in both repos (catalog + cs join seam).
async function seedCatalog(fx: Fixture, name: string, active = true) {
  const cat = await fx.catalogRepo.create({ name, label: name, active, sortOrder: 0 });
  fx.csRepo.catalog[cat.id] = { name: cat.name, label: cat.label };
  return cat;
}

describe('POST /api/contracts/:contractId/services', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // CSV-1.1
  it('clients.write → 201 with joined view', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    const res = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id, notes: 'principal' }),
      fx.writeUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.contractId).toBe('C');
    expect(res.body.serviceCatalogId).toBe(cat.id);
    expect(res.body.name).toBe('INTERNET');
    expect(res.body.status).toBe('active');
    expect(res.body.notes).toBe('principal');
  });

  // CSV-1.2
  it('duplicate → 409 CONTRACT_SERVICE_DUPLICATE', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    await asUser(request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }), fx.writeUserId);
    const res = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.writeUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONTRACT_SERVICE_DUPLICATE');
  });

  // CSV-1.3
  it('inactive catalog entry → 422 SERVICE_CATALOG_INACTIVE', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'TV', false);
    const res = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.writeUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SERVICE_CATALOG_INACTIVE');
  });

  // CSV-1.4
  it('contract not found → 404 CONTRACT_NOT_FOUND', async () => {
    const cat = await seedCatalog(fx, 'INTERNET');
    const res = await asUser(
      request(fx.app).post('/api/contracts/X/services').send({ serviceCatalogId: cat.id }),
      fx.writeUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
  });

  // CSV-1.5
  it('catalog entry not found → 404 SERVICE_CATALOG_NOT_FOUND', async () => {
    fx.contracts.add('C');
    const res = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: '999' }),
      fx.writeUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SERVICE_CATALOG_NOT_FOUND');
  });

  // CSV-1.6
  it('only clients.read → 403', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    const res = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/contracts/:contractId/services/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // CSV-2.1
  it('status → inactive returns 200', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    const add = await asUser(request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }), fx.writeUserId);
    const res = await asUser(
      request(fx.app).patch(`/api/contracts/C/services/${add.body.id}`).send({ status: 'inactive' }),
      fx.writeUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('inactive');
  });

  // CSV-2.2
  it('notes only → 200', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    const add = await asUser(request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }), fx.writeUserId);
    const res = await asUser(
      request(fx.app).patch(`/api/contracts/C/services/${add.body.id}`).send({ notes: 'secundario' }),
      fx.writeUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('secundario');
  });

  // #65 fix wave H3 — the contract-service response NEVER leaks the TV credentials.
  it('H3 — PATCH response on a Gigared-managed TV row strips tvLogin/tvPassword', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'TV');
    // Seed a managed TV row carrying credentials directly via the repo (mirrors register).
    const row = await fx.csRepo.add({
      contractId: 'C', serviceCatalogId: cat.id,
      notes: 'CIC 0000001234 · Gigared Play Full', tvLogin: 'GIGA2432', tvPassword: 'ip243200',
    });
    const res = await asUser(
      request(fx.app).patch(`/api/contracts/C/services/${row.id}`).send({ notes: 'updated' }),
      fx.writeUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe('updated');
    // The password (and login) must NEVER ride out on a contract-service response.
    expect(res.body.tvPassword).toBeUndefined();
    expect(res.body.tvLogin).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('ip243200');
  });

  // CSV-2.4
  it('unknown id → 404 CONTRACT_SERVICE_NOT_FOUND', async () => {
    fx.contracts.add('C');
    const res = await asUser(
      request(fx.app).patch('/api/contracts/C/services/nope').send({ status: 'inactive' }),
      fx.writeUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_SERVICE_NOT_FOUND');
  });
});

describe('DELETE /api/contracts/:contractId/services/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // CSV-3.1
  it('existing service → 204', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    const add = await asUser(request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }), fx.writeUserId);
    const res = await asUser(request(fx.app).delete(`/api/contracts/C/services/${add.body.id}`), fx.writeUserId);
    expect(res.status).toBe(204);
  });

  // CSV-3.2 — idempotent
  it('non-existent service → 204 (idempotent)', async () => {
    fx.contracts.add('C');
    const res = await asUser(request(fx.app).delete('/api/contracts/C/services/nope'), fx.writeUserId);
    expect(res.status).toBe(204);
  });
});

describe('PATCH /api/contracts/:id (name)', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // CN-2.1
  it('set name → 200 { id, name }', async () => {
    fx.contractRepo.seed({ id: 'C', clientName: 'Acme', plan: 'P1' });
    const res = await asUser(request(fx.app).patch('/api/contracts/C').send({ name: 'Fibra Casa' }), fx.writeUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'C', name: 'Fibra Casa' });
  });

  // CN-2.2
  it('empty string → name stored as null', async () => {
    fx.contractRepo.seed({ id: 'C', clientName: 'Acme', plan: 'P1' });
    const res = await asUser(request(fx.app).patch('/api/contracts/C').send({ name: '' }), fx.writeUserId);
    expect(res.status).toBe(200);
    expect(res.body.name).toBeNull();
  });

  // CN-2.3
  it('non-existent contract → 404 CONTRACT_NOT_FOUND', async () => {
    const res = await asUser(request(fx.app).patch('/api/contracts/X').send({ name: 'Test' }), fx.writeUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
  });

  // CN-2.4
  it('only clients.read → 403', async () => {
    fx.contractRepo.seed({ id: 'C', clientName: 'Acme', plan: 'P1' });
    const res = await asUser(request(fx.app).patch('/api/contracts/C').send({ name: 'Test' }), fx.readOnlyUserId);
    expect(res.status).toBe(403);
  });

  // W-3 — empty body {} is a valid no-op: 200 with the contract unchanged.
  it('empty body {} → 200 no-op, returns current name unchanged', async () => {
    fx.contractRepo.seed({ id: 'C', clientName: 'Acme', plan: 'P1' });
    fx.contractRepo.names['C'] = 'Existing';
    const res = await asUser(request(fx.app).patch('/api/contracts/C').send({}), fx.writeUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'C', name: 'Existing' });
    expect(fx.contractRepo.names['C']).toBe('Existing');
  });
});

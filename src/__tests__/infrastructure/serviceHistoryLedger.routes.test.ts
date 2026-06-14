/**
 * #110 — service-history-ledger route tests.
 * Verifies:
 *   R3.1: GET /contracts/:contractId/service-history returns 200 with items having events[]
 *   R3.2: 401 without auth; 403 without clients.read
 *   R1.4: tvPassword absent from entire response body
 *   R2.1: POST /services registers an activated event (wired best-effort)
 *   R2.4: DELETE /services/:id registers a deactivated event for active service
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryTvActivationEventRepository } from '@infrastructure/adapters/in-memory/InMemoryTvActivationEventRepository';
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
    // token is the userId (set by the tests)
    return { id: token, username: `user-${token}`, email: `${token}@test.com` };
  }
}

interface Fixture {
  app: express.Express;
  catalogRepo: InMemoryServiceCatalogRepository;
  csRepo: InMemoryContractServiceRepository;
  cseRepo: InMemoryContractServiceEventRepository;
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
  const cseRepo      = new InMemoryContractServiceEventRepository();
  const tvEventRepo  = new InMemoryTvActivationEventRepository();
  const contractRepo = new InMemoryContractRepository();
  const contracts    = new Set<string>();
  const contractLookup = { findById: async (id: string) => (contracts.has(id) ? { id } : null) };

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createContractServicesRouter(
    new EchoAuthProvider(),
    requirePerm,
    new UpdateContractName(contractRepo),
    new AddContractService(csRepo, catalogRepo, contractLookup, cseRepo),
    new UpdateContractService(csRepo, cseRepo),
    new RemoveContractService(csRepo, cseRepo),
    new ListContractServiceHistory(csRepo, cseRepo, tvEventRepo),
  ));
  app.use(errorHandler);

  return { app, catalogRepo, csRepo, cseRepo, contracts, writeUserId: writeUser.id, readOnlyUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedCatalog(fx: Fixture, name: string, active = true) {
  const cat = await fx.catalogRepo.create({ name, label: name, active, sortOrder: 0 });
  fx.csRepo.catalog[cat.id] = { name: cat.name, label: cat.label };
  return cat;
}

describe('service-history-ledger routes — #110', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // R3.1 — GET returns 200 with items containing events[]
  it('R3.1 GET /service-history returns 200 with items having events[]', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    await fx.csRepo.add({ contractId: 'C', serviceCatalogId: cat.id });

    const res = await asUser(request(fx.app).get('/api/contracts/C/service-history'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('events');
    expect(Array.isArray(res.body[0].events)).toBe(true);
  });

  // R3.1 — events[] contains the synthesized or real events
  it('R3.1 events[] is present and non-empty (legacy synthesis for new service)', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    await fx.csRepo.add({ contractId: 'C', serviceCatalogId: cat.id });

    const res = await asUser(request(fx.app).get('/api/contracts/C/service-history'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    // Legacy synthesis: at minimum an 'activated' event
    expect(res.body[0].events.length).toBeGreaterThan(0);
    expect(res.body[0].events[0].eventType).toBe('activated');
  });

  // R3.2 — 401 without auth
  it('R3.2 GET returns 401 when not authenticated', async () => {
    const res = await request(fx.app).get('/api/contracts/C/service-history');
    expect(res.status).toBe(401);
  });

  // R3.2 — 403 without clients.read
  it('R3.2 GET returns 403 when user has no clients.read permission', async () => {
    const res = await asUser(request(fx.app).get('/api/contracts/C/service-history'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  // R1.4 — tvPassword absent from entire body
  it('R1.4 tvPassword absent from entire response body', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'TV');
    await fx.csRepo.add({ contractId: 'C', serviceCatalogId: cat.id, tvLogin: 'GIGA001', tvPassword: 'SUPER_SECRET' });

    const res = await asUser(request(fx.app).get('/api/contracts/C/service-history'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('tvPassword');
    expect(JSON.stringify(res.body)).not.toContain('SUPER_SECRET');
  });

  // R2.1 — POST /services registers activated event (actor from req.user)
  it('R2.1 POST /services registers activated event with actor', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');

    const res = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.writeUserId,
    );
    expect(res.status).toBe(201);

    // Check that the event was registered in cseRepo
    const events = await fx.cseRepo.listByContract('C');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('activated');
    // actorId should be the writeUserId (passed from req.user.id)
    expect(events[0]!.actorId).toBe(fx.writeUserId);
  });

  // R2.4 — DELETE /services/:id registers deactivated event for active service
  it('R2.4 DELETE /services/:id registers deactivated event', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    const svc = await fx.csRepo.add({ contractId: 'C', serviceCatalogId: cat.id });

    const res = await asUser(
      request(fx.app).delete(`/api/contracts/C/services/${svc.id}`),
      fx.writeUserId,
    );
    expect(res.status).toBe(204);

    const events = await fx.cseRepo.listByContract('C');
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.actorId).toBe(fx.writeUserId);
  });

  // Empty contract → empty array
  it('empty contract → 200 with empty array', async () => {
    const res = await asUser(request(fx.app).get('/api/contracts/EMPTY/service-history'), fx.readOnlyUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

/**
 * #127 -- HTTP seam tests for reason field on service cancellation.
 * Supertest + in-memory repos.
 *
 * Tests:
 *   A: DELETE with reason body -> deactivated event persists reason
 *   C: DELETE without reason -> event has reason: null (legacy-compatible)
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
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
  eventRepo: InMemoryContractServiceEventRepository;
  contractRepo: InMemoryContractRepository;
  contracts: Set<string>;
  writeUserId: string;
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

  const writeRole = await roleRepo.create({ code: 'cli_writer', label: 'Cli Writer', isSystem: false });
  const writePerm = await permRepo.seed({ moduleCode: 'clients', action: 'write' });
  await rolePermRepo.grant(writeRole.id, writePerm.id);

  const pwHash = await hasher.hash('pw');
  const writeUser = await userRepo.create({
    name: 'writer', email: 'writer@x.com', login: 'writer', passwordHash: pwHash, status: 'active',
  });
  await userRoleRepo.assign(writeUser.id, writeRole.id);

  const catalogRepo  = new InMemoryServiceCatalogRepository();
  const csRepo       = new InMemoryContractServiceRepository();
  const eventRepo    = new InMemoryContractServiceEventRepository();
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
    new AddContractService(csRepo, catalogRepo, contractLookup),
    new UpdateContractService(csRepo, eventRepo),
    new RemoveContractService(csRepo, eventRepo),
    new ListContractServiceHistory(csRepo),
  ));
  app.use(errorHandler);

  return { app, catalogRepo, csRepo, eventRepo, contractRepo, contracts, writeUserId: writeUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedCatalog(fx: Fixture, name: string, active = true) {
  const cat = await fx.catalogRepo.create({ name, label: name, active, sortOrder: 0 });
  fx.csRepo.catalog[cat.id] = { name: cat.name, label: cat.label };
  return cat;
}

describe('DELETE /api/contracts/:contractId/services/:id -- reason field (HTTP seam, #127)', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  // Test A: DELETE with reason body -> event persists reason
  it('A: with reason body -> deactivated event persists reason', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    const addRes = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.writeUserId,
    );
    const serviceId = addRes.body.id as string;

    const res = await asUser(
      request(fx.app)
        .delete(`/api/contracts/C/services/${serviceId}`)
        .send({ reason: 'cliente se muda' }),
      fx.writeUserId,
    );

    expect(res.status).toBe(204);

    // Verify the event was recorded with the reason via the HTTP seam
    const events = fx.eventRepo.all();
    const deactivated = events.find(e => e.eventType === 'deactivated');
    expect(deactivated).toBeDefined();
    expect(deactivated!.reason).toBe('cliente se muda');
  });

  // Test C: DELETE without reason -> event with reason: null (legacy-compatible)
  it('C: without reason -> deactivated event has reason: null (legacy-compatible)', async () => {
    fx.contracts.add('C');
    const cat = await seedCatalog(fx, 'INTERNET');
    const addRes = await asUser(
      request(fx.app).post('/api/contracts/C/services').send({ serviceCatalogId: cat.id }),
      fx.writeUserId,
    );
    const serviceId = addRes.body.id as string;

    // DELETE with no body at all (legacy callers send no reason)
    const res = await asUser(
      request(fx.app).delete(`/api/contracts/C/services/${serviceId}`),
      fx.writeUserId,
    );

    expect(res.status).toBe(204);

    // Event must exist but with reason: null
    const events = fx.eventRepo.all();
    const deactivated = events.find(e => e.eventType === 'deactivated');
    expect(deactivated).toBeDefined();
    expect(deactivated!.reason).toBeNull();
  });
});

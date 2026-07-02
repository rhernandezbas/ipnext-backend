/**
 * pppoe.search-ip-mac.routes.test.ts — route seam tests for IP/MAC search extension.
 * TDD (task 1.6): route → use case REAL → in-memory repo.
 * No mocks on the use case (lesson #28).
 *
 * Covers:
 *   - IP exact match
 *   - IP partial match
 *   - MAC in colon format (AA:BB:CC:DD:EE:FF)
 *   - MAC in dash format (aa-bb-cc-dd-ee-ff)
 *   - MAC plain (aabbccddeeff)
 *   - MAC partial prefix
 *   - callerId=null does NOT match MAC search
 *   - regression: username search still works
 *   - regression: customer name search still works
 *   - callerId is present in list items
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { createPppoeRouter } from '@infrastructure/http/routes/pppoe.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';

import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { RouterOsEnforcementAdapter } from '@infrastructure/adapters/routeros/RouterOsEnforcementAdapter';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryServiceCutBatchRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCutBatchRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';

import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { DeactivatePppoeService } from '@application/use-cases/DeactivatePppoeService';
import { EnforcePppoeService } from '@application/use-cases/EnforcePppoeService';
import { PreviewEnforcement } from '@application/use-cases/PreviewEnforcement';
import { RunBulkEnforcement } from '@application/use-cases/RunBulkEnforcement';
import { ServiceCutRunner } from '@infrastructure/scheduling/ServiceCutRunner';
import { IngestPppoeFromNas } from '@application/use-cases/IngestPppoeFromNas';
import { AssociatePppoeToContract } from '@application/use-cases/AssociatePppoeToContract';
import { GetPppoeCredentials } from '@application/use-cases/GetPppoeCredentials';
import { ListUnassignedPppoe } from '@application/use-cases/ListUnassignedPppoe';
import { DeassociatePppoeFromContract } from '@application/use-cases/DeassociatePppoeFromContract';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { ListAllPppoeServices } from '@application/use-cases/ListAllPppoeServices';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

// NAS id='1' is mikrotik_api in InMemoryNasRepository
const NAS_ID = '1';
const CONTRACT_ID = 'ctr-search-test';

class EchoAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'uid-read', username: 'reader', email: 'r@x.com', role: 'admin' as const },
      cookieValue: 'x',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    return { id: token, username: 'reader', email: 'r@x.com', role: 'admin' };
  }
}

interface Fixture {
  app: express.Express;
  pppoeRepo: InMemoryPppoeServiceRepository;
  readUserId: string;
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
    const roles = await Promise.all(roleIds.map(id => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('@domain/entities/rbac').RbacPermission[] = [];
    const allPerms = await permRepo.listAll();
    for (const roleId of roleIds) {
      const permIds = await rolePermRepo.listForRole(roleId);
      for (const permId of permIds) {
        const p = allPerms.find(ap => ap.id === permId);
        if (p) perms.push(p);
      }
    }
    return perms;
  };

  const readerRole = await roleRepo.create({ code: 'pppoe_reader', label: 'PPPoE Reader', isSystem: false });
  const readPerm   = await permRepo.seed({ moduleCode: 'pppoe', action: 'read' });
  const cutPerm    = await permRepo.seed({ moduleCode: 'pppoe', action: 'cut' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);
  await rolePermRepo.grant(readerRole.id, cutPerm.id);

  const pwHash = await hasher.hash('pw');
  const readUser = await userRepo.create({ name: 'Reader', email: 'r@x.com', login: 'r', passwordHash: pwHash, status: 'active' });
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const pppoeRepo  = new InMemoryPppoeServiceRepository();
  const routerGw   = new InMemoryRouterGateway();
  const nasRepo    = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const csRepo     = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const eventRepo  = new InMemoryContractServiceEventRepository();
  const ensure     = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);
  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const batchRepo  = new InMemoryServiceCutBatchRepository();
  const lock       = new InMemoryDistributedLock();
  const enforce    = new EnforcePppoeService(pppoeRepo, new RouterOsEnforcementAdapter(routerGw, 'IP-REDUCCION'), nasRepo);
  const preview    = new PreviewEnforcement(pppoeRepo);
  const bulk       = new RunBulkEnforcement(pppoeRepo, enforce, batchRepo, { throttleMs: 0 });
  const runner     = new ServiceCutRunner(bulk, batchRepo, lock);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createPppoeRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new ListPppoeByContract(pppoeRepo),
    new CreatePppoeService(pppoeRepo, routerGw, nasRepo, orchestrator, ensure),
    new UpdatePppoeService(pppoeRepo, routerGw, nasRepo, orchestrator),
    new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo),
    new DeactivatePppoeService(pppoeRepo, routerGw, nasRepo, orchestrator, ensure),
    enforce,
    preview,
    runner,
    batchRepo,
    new IngestPppoeFromNas(pppoeRepo, nasRepo, orchestrator),
    new AssociatePppoeToContract(pppoeRepo, ensure),
    new GetPppoeCredentials(pppoeRepo),
    new ListUnassignedPppoe(pppoeRepo),
    new DeassociatePppoeFromContract(pppoeRepo, ensure),
    undefined, // terminatePppoeService
    undefined, // getPppoeCallerId
    new ListAllPppoeServices(pppoeRepo, eventRepo, catalogRepo),
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, readUserId: readUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedService(
  pppoeRepo: InMemoryPppoeServiceRepository,
  overrides: {
    username?: string;
    contractId?: string;
    remoteAddress?: string | null;
    callerId?: string | null;
    customerName?: string;
  } = {},
) {
  const s = await pppoeRepo.upsertByUsername({
    username:      overrides.username ?? 'user@test',
    password:      'secret',
    profile:       'IP-30M',
    nasId:         NAS_ID,
    contractId:    overrides.contractId ?? CONTRACT_ID,
    status:        'enabled',
    remoteAddress: overrides.remoteAddress !== undefined ? overrides.remoteAddress : null,
  });
  if (overrides.callerId) {
    await pppoeRepo.setCallerId(s.id, overrides.callerId);
  }
  if (overrides.customerName) {
    pppoeRepo.setContractClient(s.contractId!, 'cli-1', overrides.customerName);
  }
  return pppoeRepo.findById(s.id);
}

// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/pppoe — search by IP (route seam)', () => {
  it('IP exact match finds the service', async () => {
    const fx = await buildApp();
    await seedService(fx.pppoeRepo, { username: 'a@test', remoteAddress: '100.64.28.5' });

    const res = await asUser(request(fx.app).get('/api/pppoe?search=100.64.28.5'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].username).toBe('a@test');
  });

  it('IP partial match finds multiple services', async () => {
    const fx = await buildApp();
    await seedService(fx.pppoeRepo, { username: 'a@test', contractId: 'ctr-a', remoteAddress: '100.64.28.5' });
    await seedService(fx.pppoeRepo, { username: 'b@test', contractId: 'ctr-b', remoteAddress: '100.64.28.9' });

    const res = await asUser(request(fx.app).get('/api/pppoe?search=100.64.28'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('IP search does NOT match services with a different IP', async () => {
    const fx = await buildApp();
    await seedService(fx.pppoeRepo, { username: 'a@test', contractId: 'ctr-a', remoteAddress: '100.64.28.5' });
    await seedService(fx.pppoeRepo, { username: 'b@test', contractId: 'ctr-b', remoteAddress: '10.75.0.1' });

    const res = await asUser(request(fx.app).get('/api/pppoe?search=100.64.28.5'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].username).toBe('a@test');
  });
});

describe('GET /api/pppoe — search by MAC (route seam)', () => {
  it('MAC in colon format finds the service', async () => {
    const fx = await buildApp();
    await seedService(fx.pppoeRepo, { username: 'mac@test', callerId: 'AA:BB:CC:DD:EE:FF' });

    const res = await asUser(request(fx.app).get('/api/pppoe?search=AA:BB:CC:DD:EE:FF'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].username).toBe('mac@test');
  });

  it('MAC in dash format finds service stored with colons', async () => {
    const fx = await buildApp();
    await seedService(fx.pppoeRepo, { username: 'mac@test', callerId: 'AA:BB:CC:DD:EE:FF' });

    const res = await asUser(request(fx.app).get('/api/pppoe?search=aa-bb-cc-dd-ee-ff'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('MAC plain (no separators) finds service stored with colons', async () => {
    const fx = await buildApp();
    await seedService(fx.pppoeRepo, { username: 'mac@test', callerId: 'AA:BB:CC:DD:EE:FF' });

    const res = await asUser(request(fx.app).get('/api/pppoe?search=aabbccddeeff'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('MAC partial prefix finds the service', async () => {
    const fx = await buildApp();
    await seedService(fx.pppoeRepo, { username: 'mac@test', callerId: 'AA:BB:CC:DD:EE:FF' });

    const res = await asUser(request(fx.app).get('/api/pppoe?search=aabbcc'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('service with callerId=null does NOT match MAC search', async () => {
    const fx = await buildApp();
    // Service with no callerId set
    await seedService(fx.pppoeRepo, { username: 'nomac@test' });

    const res = await asUser(request(fx.app).get('/api/pppoe?search=aabbccddeeff'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe('GET /api/pppoe — search regression (username + customer name)', () => {
  it('username search still works', async () => {
    const fx = await buildApp();
    await seedService(fx.pppoeRepo, { username: 'juan@ipnext.com.ar', contractId: 'ctr-juan' });
    await seedService(fx.pppoeRepo, { username: 'pedro@ipnext.com.ar', contractId: 'ctr-pedro' });

    const res = await asUser(request(fx.app).get('/api/pppoe?search=juan'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].username).toBe('juan@ipnext.com.ar');
  });

  it('customer name search still works', async () => {
    const fx = await buildApp();
    await seedService(fx.pppoeRepo, {
      username: 'svc@test',
      contractId: 'ctr-gonzalez',
      customerName: 'María González',
    });

    const res = await asUser(request(fx.app).get('/api/pppoe?search=gonz'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].username).toBe('svc@test');
  });
});

describe('GET /api/pppoe — callerId in list items', () => {
  it('item includes callerId when set', async () => {
    const fx = await buildApp();
    await seedService(fx.pppoeRepo, { username: 'svc@test', callerId: 'AA:BB:CC:DD:EE:FF' });

    const res = await asUser(request(fx.app).get('/api/pppoe'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data[0].callerId).toBe('AA:BB:CC:DD:EE:FF');
    expect(res.body.data[0]).not.toHaveProperty('password');
  });

  it('item has callerId=null when not set', async () => {
    const fx = await buildApp();
    await seedService(fx.pppoeRepo, { username: 'svc@test' });

    const res = await asUser(request(fx.app).get('/api/pppoe'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.data[0].callerId).toBeNull();
  });
});

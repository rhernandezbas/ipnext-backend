/**
 * pppoe.pin-ip.routes.test.ts — supertest para los endpoints pppoe-pool-ip:
 *   POST /api/pppoe/:id/pin-ip    (gate pppoe.manage)
 *   POST /api/pppoe/:id/unpin-ip  (gate pppoe.manage)
 *
 * Foco: el MAPEO error→HTTP de la ruta (falsificable: si el mapeo se rompe, el status cambia).
 *   pin-ip:   200 OK · 422 IP inválida (INVALID_IP_FORMAT) · 409 IP tomada (IP_ALREADY_TAKEN)
 *             · 502 orchestrator caído (ORCHESTRATOR_UNREACHABLE) · 401 sin auth · 403 sin manage
 *   unpin-ip: 200 OK · 409 NAS no pool-mode (NAS_NO_POOL) · 401 sin auth · 403 sin manage
 *
 * Patrón espejo de pppoe.routes.test.ts (EchoAuthProvider + cookie token = userId + RBAC in-memory).
 * NAS seed (InMemoryNasRepository): id='1' mikrotik_api (sin poolName) · id='3' radius_orchestrator
 * (poolName='asur-cgnat' → pool-mode).
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
import { PinPppoeIp } from '@application/use-cases/PinPppoeIp';
import { UnpinPppoeIp } from '@application/use-cases/UnpinPppoeIp';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

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

const RADIUS_NAS = '3'; // radius_orchestrator + poolName='asur-cgnat' (seed)
const MK_NAS      = '1'; // mikrotik_api, sin poolName

interface Fixture {
  app: express.Express;
  pppoeRepo: InMemoryPppoeServiceRepository;
  readUserId: string;
  manageUserId: string;
}

async function buildApp(opts?: { assignedIps?: string[]; unreachableUsers?: string[] }): Promise<Fixture> {
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

  const readerRole  = await roleRepo.create({ code: 'pppoe_reader', label: 'PPPoE Reader', isSystem: false });
  const managerRole = await roleRepo.create({ code: 'pppoe_manager', label: 'PPPoE Manager', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'pppoe', action: 'read' });
  const managePerm  = await permRepo.seed({ moduleCode: 'pppoe', action: 'manage' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser   = await mkUser('reader');
  const manageUser = await mkUser('manager');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const routerGw  = new InMemoryRouterGateway();
  const nasRepo   = new InMemoryNasRepository();
  const csRepo    = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const ensure    = new EnsureInternetContractService(csRepo, catalogRepo);
  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    assignedIps: opts?.assignedIps,
    unreachable: opts?.unreachableUsers,
  });

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const batchRepo = new InMemoryServiceCutBatchRepository();
  const lock = new InMemoryDistributedLock();
  const enforce = new EnforcePppoeService(pppoeRepo, new RouterOsEnforcementAdapter(routerGw, 'IP-REDUCCION'), nasRepo);
  const preview = new PreviewEnforcement(pppoeRepo);
  const bulk = new RunBulkEnforcement(pppoeRepo, enforce, batchRepo, { throttleMs: 0 });
  const runner = new ServiceCutRunner(bulk, batchRepo, lock);

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
    undefined, // listAllPppoeServices
    undefined, // listInternetServiceHistory
    undefined, // listInternetActivationOperators
    new PinPppoeIp(pppoeRepo, nasRepo, orchestrator),
    new UnpinPppoeIp(pppoeRepo, nasRepo, orchestrator),
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, readUserId: readUser.id, manageUserId: manageUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedPppoe(
  pppoeRepo: InMemoryPppoeServiceRepository,
  opts?: { username?: string; nasId?: string; ipMode?: 'pool' | 'fixed'; remoteAddress?: string | null },
) {
  return pppoeRepo.upsertByUsername({
    username: opts?.username ?? 'pinuser',
    password: 'secret',
    nasId: opts?.nasId ?? RADIUS_NAS,
    status: 'enabled',
    ipMode: opts?.ipMode ?? 'pool',
    remoteAddress: opts?.remoteAddress ?? null,
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// POST /api/pppoe/:id/pin-ip
// ════════════════════════════════════════════════════════════════════════════════

describe('POST /api/pppoe/:id/pin-ip (pppoe.manage)', () => {
  it('401 sin auth', async () => {
    const { app } = await buildApp();
    expect((await request(app).post('/api/pppoe/x/pin-ip').send({ ip: '100.64.10.10' })).status).toBe(401);
  });

  it('403 con pppoe.read solo (gate pppoe.manage)', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx.pppoeRepo);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/pin-ip`).send({ ip: '100.64.10.10' }), fx.readUserId);
    expect(res.status).toBe(403);
  });

  it('pin exitoso → 200 con ipMode=fixed + remoteAddress', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx.pppoeRepo);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/pin-ip`).send({ ip: '100.64.10.50' }), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.ipMode).toBe('fixed');
    expect(res.body.remoteAddress).toBe('100.64.10.50');
    expect(res.body.password).toBeUndefined();
  });

  it('IP con formato inválido → 422 INVALID_IP_FORMAT', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx.pppoeRepo);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/pin-ip`).send({ ip: '999.1.2.3' }), fx.manageUserId);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_IP_FORMAT');
  });

  it('IP ya tomada por OTRO → 409 IP_ALREADY_TAKEN', async () => {
    const fx = await buildApp({ assignedIps: ['100.64.10.77'] });
    const s = await seedPppoe(fx.pppoeRepo);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/pin-ip`).send({ ip: '100.64.10.77' }), fx.manageUserId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IP_ALREADY_TAKEN');
  });

  it('orchestrator caído → 502 ORCHESTRATOR_UNREACHABLE', async () => {
    const fx = await buildApp({ unreachableUsers: ['downuser'] });
    const s = await seedPppoe(fx.pppoeRepo, { username: 'downuser' });
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/pin-ip`).send({ ip: '100.64.10.60' }), fx.manageUserId);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ORCHESTRATOR_UNREACHABLE');
  });

  it('PPPoE inexistente → 404 PPPOE_NOT_FOUND', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).post('/api/pppoe/no-existe/pin-ip').send({ ip: '100.64.10.10' }), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PPPOE_NOT_FOUND');
  });

  it('body sin ip → 422 VALIDATION_ERROR', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx.pppoeRepo);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/pin-ip`).send({}), fx.manageUserId);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// POST /api/pppoe/:id/unpin-ip
// ════════════════════════════════════════════════════════════════════════════════

describe('POST /api/pppoe/:id/unpin-ip (pppoe.manage)', () => {
  it('401 sin auth', async () => {
    const { app } = await buildApp();
    expect((await request(app).post('/api/pppoe/x/unpin-ip')).status).toBe(401);
  });

  it('403 con pppoe.read solo (gate pppoe.manage)', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx.pppoeRepo, { ipMode: 'fixed', remoteAddress: '100.64.10.10' });
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/unpin-ip`), fx.readUserId);
    expect(res.status).toBe(403);
  });

  it('unpin exitoso (NAS pool-mode) → 200 con ipMode=pool + remoteAddress=null', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx.pppoeRepo, { nasId: RADIUS_NAS, ipMode: 'fixed', remoteAddress: '100.64.10.10' });
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/unpin-ip`), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.ipMode).toBe('pool');
    expect(res.body.remoteAddress).toBeNull();
  });

  it('NAS NO pool-mode (mikrotik, sin poolName) → 409 NAS_NO_POOL', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx.pppoeRepo, { nasId: MK_NAS, ipMode: 'fixed', remoteAddress: '100.64.10.10' });
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/unpin-ip`), fx.manageUserId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAS_NO_POOL');
  });

  it('PPPoE inexistente → 404 PPPOE_NOT_FOUND', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).post('/api/pppoe/no-existe/unpin-ip'), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PPPOE_NOT_FOUND');
  });
});

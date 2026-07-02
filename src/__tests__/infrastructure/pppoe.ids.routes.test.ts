/**
 * pppoe.ids.routes.test.ts — route seam tests (pppoe-bulk-select-filter v2, tasks 2.1/2.2)
 * TDD: route → use case REAL → repo in-memory. No mocks on use cases (lesson #28).
 *
 * Route under test: GET /api/pppoe/ids
 *
 * Covers:
 *   - por nasId / por search (username, IP, MAC) / por status / combinaciones
 *   - paridad con GET /api/pppoe (mismo filtro → mismos ids que barrer TODO el listado)
 *   - sin filtro (solo includeUnassigned) → 400 FILTER_REQUIRED
 *   - sin permiso pppoe.manage (incl. con SOLO pppoe.read) → 403
 *   - sin token → 401
 *   - composition: la ruta vive (no 404)
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
import { ListAllPppoeServiceIds } from '@application/use-cases/ListAllPppoeServiceIds';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

class EchoAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'x', username: 'admin', email: 'admin@x.com', role: 'admin' as const },
      cookieValue: 'x',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    return { id: token, username: 'admin', email: 'admin@x.com', role: 'admin' };
  }
}

interface Fixture {
  app: express.Express;
  pppoeRepo: InMemoryPppoeServiceRepository;
  readUserId: string;
  manageUserId: string;
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

  const readerRole  = await roleRepo.create({ code: 'pppoe_reader', label: 'PPPoE Reader', isSystem: false });
  const managerRole = await roleRepo.create({ code: 'pppoe_manager', label: 'PPPoE Manager', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'pppoe', action: 'read' });
  const managePerm  = await permRepo.seed({ moduleCode: 'pppoe', action: 'manage' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const readUser   = await userRepo.create({ name: 'reader',  email: 'r@x.com', login: 'r', passwordHash: pwHash, status: 'active' });
  const manageUser = await userRepo.create({ name: 'manager', email: 'm@x.com', login: 'm', passwordHash: pwHash, status: 'active' });
  const noPermUser = await userRepo.create({ name: 'noperm',  email: 'n@x.com', login: 'n', passwordHash: pwHash, status: 'active' });
  await userRoleRepo.assign(readUser.id, readerRole.id);
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const routerGw    = new InMemoryRouterGateway();
  const nasRepo     = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway({ seed: [] });

  const csRepo      = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  await catalogRepo.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
  const eventRepo   = new InMemoryContractServiceEventRepository();
  const ensure      = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const batchRepo = new InMemoryServiceCutBatchRepository();
  const lock = new InMemoryDistributedLock();
  const enforce = new EnforcePppoeService(pppoeRepo, new RouterOsEnforcementAdapter(routerGw, 'IP-REDUCCION'), nasRepo);
  const preview = new PreviewEnforcement(pppoeRepo);
  const bulk = new RunBulkEnforcement(pppoeRepo, enforce, batchRepo, { throttleMs: 0 });
  const runner = new ServiceCutRunner(bulk, batchRepo, lock);

  const listAllPppoeServices = new ListAllPppoeServices(pppoeRepo, eventRepo, catalogRepo, nasRepo);
  const listAllPppoeServiceIds = new ListAllPppoeServiceIds(pppoeRepo);

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
    listAllPppoeServices,
    undefined, // listInternetServiceHistory
    undefined, // listInternetActivationOperators
    undefined, // pinPppoeIp
    undefined, // unpinPppoeIp
    undefined, // createPppoeStandalone
    undefined, // renamePppoeUsername
    undefined, // movePppoeToNas
    undefined, // listPppoeNasMoveEvents
    undefined, // bulkChangePppoePlan
    listAllPppoeServiceIds,
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, readUserId: readUser.id, manageUserId: manageUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

/** Barre TODAS las páginas de GET /api/pppoe (vía HTTP, seam real) y junta los ids. */
async function sweepListIdsViaHttp(app: express.Express, userId: string, qs: string): Promise<string[]> {
  const collected: string[] = [];
  let page = 1;
  const pageSize = 5;
  for (;;) {
    const res = await asUser(request(app).get(`/api/pppoe?page=${page}&limit=${pageSize}${qs ? `&${qs}` : ''}`), userId);
    expect(res.status).toBe(200);
    collected.push(...res.body.data.map((d: { id: string }) => d.id));
    if (page * pageSize >= res.body.total) break;
    page += 1;
  }
  return collected;
}

async function seedFixtureData(pppoeRepo: InMemoryPppoeServiceRepository) {
  for (let i = 0; i < 12; i++) {
    const nasId = i % 2 === 0 ? 'NE8000-1' : 'NE8000-2';
    await pppoeRepo.upsertByUsername({
      username: `juan${i}@test`, password: 'x', nasId, status: 'enabled', enforcedState: 'active', contractId: `ct-${i}`,
      remoteAddress: `100.64.28.${i}`,
    });
  }
  for (let i = 0; i < 4; i++) {
    await pppoeRepo.upsertByUsername({
      username: `deudor${i}@test`, password: 'x', nasId: 'NE8000-1', status: 'enabled', enforcedState: 'reduced', contractId: `ct-red-${i}`,
    });
  }
  const macRow = await pppoeRepo.upsertByUsername({
    username: 'con-mac@test', password: 'x', nasId: 'NE8000-2', status: 'enabled', enforcedState: 'active', contractId: 'ct-mac',
  });
  await pppoeRepo.setCallerId(macRow.id, 'aa:bb:cc:dd:ee:ff');
}

// ════════════════════════════════════════════════════════════════════════════
describe('GET /api/pppoe/ids — composition (route exists)', () => {
  it('route exists — not 404', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe/ids?nasId=x'), fx.manageUserId);
    expect(res.status).not.toBe(404);
  });
});

describe('GET /api/pppoe/ids — filtros', () => {
  it('por nasId: devuelve exactamente los ids de ese NAS', async () => {
    const fx = await buildApp();
    await seedFixtureData(fx.pppoeRepo);

    const res = await asUser(request(fx.app).get('/api/pppoe/ids?nasId=NE8000-1'), fx.manageUserId);
    expect(res.status).toBe(200);
    // NE8000-1: juan0,2,4,6,8,10 (6) + deudor0..3 (4) = 10
    expect(res.body.total).toBe(10);
    expect(res.body.ids.length).toBe(res.body.total);
  });

  it('por search (username)', async () => {
    const fx = await buildApp();
    await seedFixtureData(fx.pppoeRepo);

    const res = await asUser(request(fx.app).get('/api/pppoe/ids?search=juan'), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12);
  });

  it('por search (IP)', async () => {
    const fx = await buildApp();
    await seedFixtureData(fx.pppoeRepo);

    const res = await asUser(request(fx.app).get('/api/pppoe/ids?search=100.64.28.1'), fx.manageUserId);
    expect(res.status).toBe(200);
    // matches 100.64.28.1 and 100.64.28.10, .11 (contains-match)
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.ids.length).toBe(res.body.total);
  });

  it('por search (MAC)', async () => {
    const fx = await buildApp();
    await seedFixtureData(fx.pppoeRepo);

    const res = await asUser(request(fx.app).get('/api/pppoe/ids?search=aabbccddeeff'), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('por status de negocio (reduced)', async () => {
    const fx = await buildApp();
    await seedFixtureData(fx.pppoeRepo);

    const res = await asUser(request(fx.app).get('/api/pppoe/ids?status=reduced'), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
  });

  it('combinación nasId+search', async () => {
    const fx = await buildApp();
    await seedFixtureData(fx.pppoeRepo);

    const res = await asUser(request(fx.app).get('/api/pppoe/ids?nasId=NE8000-1&search=juan'), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(6); // juan0,2,4,6,8,10
  });
});

describe('GET /api/pppoe/ids — paridad con GET /api/pppoe (guardrail riesgo #1)', () => {
  it('nasId=NE8000-1: el conjunto de /ids === el conjunto barriendo TODAS las páginas de /pppoe', async () => {
    const fx = await buildApp();
    await seedFixtureData(fx.pppoeRepo);

    const idsRes = await asUser(request(fx.app).get('/api/pppoe/ids?nasId=NE8000-1'), fx.manageUserId);
    expect(idsRes.status).toBe(200);

    const swept = await sweepListIdsViaHttp(fx.app, fx.manageUserId, 'nasId=NE8000-1');

    expect([...idsRes.body.ids].sort()).toEqual([...swept].sort());
    expect(idsRes.body.total).toBe(swept.length);
  });

  it('search=juan: el conjunto de /ids === el conjunto barriendo TODAS las páginas de /pppoe', async () => {
    const fx = await buildApp();
    await seedFixtureData(fx.pppoeRepo);

    const idsRes = await asUser(request(fx.app).get('/api/pppoe/ids?search=juan'), fx.manageUserId);
    const swept = await sweepListIdsViaHttp(fx.app, fx.manageUserId, 'search=juan');

    expect([...idsRes.body.ids].sort()).toEqual([...swept].sort());
    expect(idsRes.body.total).toBe(swept.length);
  });

  it('status=reduced: el conjunto de /ids === el conjunto barriendo TODAS las páginas de /pppoe', async () => {
    const fx = await buildApp();
    await seedFixtureData(fx.pppoeRepo);

    const idsRes = await asUser(request(fx.app).get('/api/pppoe/ids?status=reduced'), fx.manageUserId);
    const swept = await sweepListIdsViaHttp(fx.app, fx.manageUserId, 'status=reduced');

    expect([...idsRes.body.ids].sort()).toEqual([...swept].sort());
    expect(idsRes.body.total).toBe(swept.length);
  });
});

describe('GET /api/pppoe/ids — precondición de filtro activo', () => {
  it('sin ningún filtro → 400 FILTER_REQUIRED, cero ids devueltos', async () => {
    const fx = await buildApp();
    await seedFixtureData(fx.pppoeRepo);

    const res = await asUser(request(fx.app).get('/api/pppoe/ids'), fx.manageUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILTER_REQUIRED');
    expect(res.body.ids).toBeUndefined();
  });

  it('SOLO includeUnassigned=true (sin search/status/nasId) → 400 FILTER_REQUIRED', async () => {
    const fx = await buildApp();
    await seedFixtureData(fx.pppoeRepo);

    const res = await asUser(request(fx.app).get('/api/pppoe/ids?includeUnassigned=true'), fx.manageUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILTER_REQUIRED');
  });
});

describe('GET /api/pppoe/ids — autenticación y permisos', () => {
  it('sin token → 401', async () => {
    const fx = await buildApp();
    const res = await request(fx.app).get('/api/pppoe/ids?nasId=x');
    expect(res.status).toBe(401);
  });

  it('sin pppoe.manage (usuario totalmente sin permisos) → 403', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe/ids?nasId=x'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('CON pppoe.read pero SIN pppoe.manage → 403 (gate es manage, no read)', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe/ids?nasId=x'), fx.readUserId);
    expect(res.status).toBe(403);
  });
});

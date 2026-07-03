/**
 * TDD — internet-history routes (vista GLOBAL de servicios de internet, espejo de TV).
 *
 * Wire contract:
 *   GET /api/pppoe?search=&status=&nasId=&page=&limit=
 *     → 200 PppoeServiceListPageDto { data, total, page, limit } (DTO SIN password)
 *     → 403 sin pppoe.read
 *
 *   GET /api/pppoe/activation-history?actorId=&customerId=&from=&to=
 *     → 200 InternetServiceEventDto[] (newest-first, SOLO eventos de internet)
 *     → 403 sin pppoe.read
 *
 * Seam de ruta: el use case es REAL (in-memory repos), no se mockea.
 * Route ordering: /pppoe y /pppoe/activation-history NO deben ser sombreadas por /pppoe/:id.
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
import { InMemoryPlanRepository } from '@infrastructure/adapters/in-memory/InMemoryPlanRepository';

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
import { ListInternetServiceHistory } from '@application/use-cases/ListInternetServiceHistory';
import { ListInternetActivationOperators } from '@application/use-cases/ListInternetActivationOperators';

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
  eventRepo: InMemoryContractServiceEventRepository;
  catalogRepo: InMemoryServiceCatalogRepository;
  internetId: string;
  readUserId: string;
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

  const readerRole = await roleRepo.create({ code: 'pppoe_reader', label: 'PPPoE Reader', isSystem: false });
  const readPerm   = await permRepo.seed({ moduleCode: 'pppoe', action: 'read' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  const pwHash = await hasher.hash('pw');
  const readUser = await userRepo.create({ name: 'reader', email: 'reader@x.com', login: 'reader', passwordHash: pwHash, status: 'active' });
  await userRoleRepo.assign(readUser.id, readerRole.id);
  const noPermUser = await userRepo.create({ name: 'noperm', email: 'noperm@x.com', login: 'noperm', passwordHash: pwHash, status: 'active' });

  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const routerGw    = new InMemoryRouterGateway();
  const nasRepo     = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway({ seed: [] });

  const csRepo      = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const internet    = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', sortOrder: 0 });
  const eventRepo   = new InMemoryContractServiceEventRepository();
  const ensure      = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);

  // internet-history-plan-direction — catálogo de planes para derivar upgrade/downgrade por kbps.
  const planRepo    = new InMemoryPlanRepository();
  await planRepo.upsertByCode({ code: 'IP-30M', name: '30M', category: 'IP', downloadKbps: 30000, uploadKbps: 10000 });
  await planRepo.upsertByCode({ code: 'IP-50M', name: '50M', category: 'IP', downloadKbps: 50000, uploadKbps: 15000 });

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const batchRepo = new InMemoryServiceCutBatchRepository();
  const lock = new InMemoryDistributedLock();
  const enforce = new EnforcePppoeService(pppoeRepo, new RouterOsEnforcementAdapter(routerGw, 'IP-REDUCCION'), nasRepo);
  const preview = new PreviewEnforcement(pppoeRepo);
  const bulk = new RunBulkEnforcement(pppoeRepo, enforce, batchRepo, { throttleMs: 0 });
  const runner = new ServiceCutRunner(bulk, batchRepo, lock);

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
    undefined,
    undefined,
    new ListAllPppoeServices(pppoeRepo, eventRepo, catalogRepo),
    new ListInternetServiceHistory(eventRepo, catalogRepo, planRepo),
    new ListInternetActivationOperators(eventRepo, catalogRepo),
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, eventRepo, catalogRepo, internetId: internet.id, readUserId: readUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/pppoe — lista GLOBAL paginada
// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/pppoe — global internet services list (internet-history)', () => {
  it('200 con página vacía cuando no hay servicios', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 0, page: 1, limit: 20 });
  });

  it('200 lista servicios con cliente, sin exponer password', async () => {
    const fx = await buildApp();
    await fx.pppoeRepo.upsertByUsername({ username: 'juan', password: 'SECRET', nasId: 'nas-1', contractId: 'ct-1', remoteAddress: '10.0.0.1' });
    fx.pppoeRepo.setContractClient('ct-1', 'client-1', 'Juan Perez');
    await fx.eventRepo.record({ contractId: 'ct-1', serviceCatalogId: fx.internetId, eventType: 'activated', actorName: 'Operador' });

    const res = await asUser(request(fx.app).get('/api/pppoe'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const item = res.body.data[0];
    expect(item.username).toBe('juan');
    expect(item.clientId).toBe('client-1');
    expect(item.customerName).toBe('Juan Perez');
    expect(item.createdBy).toBe('Operador');
    expect(item.password).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });

  it('200 aplica filtros status (vocabulario de NEGOCIO) y nasId', async () => {
    const fx = await buildApp();
    await fx.pppoeRepo.upsertByUsername({ username: 'a', password: 'x', nasId: 'nas-1', status: 'enabled', enforcedState: 'active', contractId: 'ct-a' });
    await fx.pppoeRepo.upsertByUsername({ username: 'b', password: 'x', nasId: 'nas-2', status: 'disabled', enforcedState: 'active', contractId: 'ct-b' });

    const res = await asUser(request(fx.app).get('/api/pppoe?status=blocked&nasId=nas-2'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].username).toBe('b');
    expect(res.body.data[0].status).toBe('blocked');
  });

  it('200 pagina con page/limit', async () => {
    const fx = await buildApp();
    for (let i = 0; i < 5; i++) {
      await fx.pppoeRepo.upsertByUsername({ username: `user${i}`, password: 'x', nasId: 'nas-1', contractId: `ct-${i}` });
    }
    const res = await asUser(request(fx.app).get('/api/pppoe?page=2&limit=2'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.page).toBe(2);
    expect(res.body.limit).toBe(2);
    expect(res.body.data).toHaveLength(2);
  });

  it('403 sin pppoe.read', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/pppoe/activation-history — historial GLOBAL de internet
// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/pppoe/activation-history — global internet history (internet-history)', () => {
  it('200 con array vacío cuando no hay eventos', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe/activation-history'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('200 devuelve SOLO eventos de internet (excluye TV y otros) — la ruta no es sombreada por /:id', async () => {
    const fx = await buildApp();
    const tv = await fx.catalogRepo.create({ name: 'TV', label: 'TV', sortOrder: 1 });
    await fx.eventRepo.record({ contractId: 'ct-1', serviceCatalogId: fx.internetId, eventType: 'activated', actorName: 'Op' });
    await fx.eventRepo.record({ contractId: 'ct-1', serviceCatalogId: tv.id, eventType: 'activated', actorName: 'TV' });
    await fx.eventRepo.record({ contractId: 'ct-2', serviceCatalogId: 'other', eventType: 'activated', actorName: 'X' });

    const res = await asUser(request(fx.app).get('/api/pppoe/activation-history'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].serviceCatalogId).toBe(fx.internetId);
  });

  it('200 filtra por actorId', async () => {
    const fx = await buildApp();
    await fx.eventRepo.record({ contractId: 'ct-1', serviceCatalogId: fx.internetId, eventType: 'activated', actorId: 'a1', actorName: 'Op1' });
    await fx.eventRepo.record({ contractId: 'ct-2', serviceCatalogId: fx.internetId, eventType: 'activated', actorId: 'a2', actorName: 'Op2' });

    const res = await asUser(request(fx.app).get('/api/pppoe/activation-history?actorId=a1'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].actorId).toBe('a1');
  });

  it('200 filtra por customerId', async () => {
    const fx = await buildApp();
    fx.eventRepo.setContractClient('ct-1', 'client-1', 'Alice');
    fx.eventRepo.setContractClient('ct-2', 'client-2', 'Bob');
    await fx.eventRepo.record({ contractId: 'ct-1', serviceCatalogId: fx.internetId, eventType: 'activated', actorName: 'Op' });
    await fx.eventRepo.record({ contractId: 'ct-2', serviceCatalogId: fx.internetId, eventType: 'activated', actorName: 'Op' });

    const res = await asUser(request(fx.app).get('/api/pppoe/activation-history?customerId=client-1'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].clientId).toBe('client-1');
    expect(res.body[0].customerName).toBe('Alice');
  });

  it('200 filtra por eventType (tópico)', async () => {
    const fx = await buildApp();
    await fx.eventRepo.record({ contractId: 'ct-1', serviceCatalogId: fx.internetId, eventType: 'activated', actorName: 'Op' });
    await fx.eventRepo.record({ contractId: 'ct-2', serviceCatalogId: fx.internetId, eventType: 'modified', actorName: 'Op', oldPlan: 'IP-30M', newPlan: 'IP-50M' });

    const res = await asUser(request(fx.app).get('/api/pppoe/activation-history?eventType=modified'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].eventType).toBe('modified');
  });

  it('200 filtra por direction=upgrade y expone direction/oldPlan/newPlan en el DTO', async () => {
    const fx = await buildApp();
    await fx.eventRepo.record({ contractId: 'ct-1', serviceCatalogId: fx.internetId, eventType: 'activated', actorName: 'Op' });
    await fx.eventRepo.record({ contractId: 'ct-2', serviceCatalogId: fx.internetId, eventType: 'modified', actorName: 'Op', oldPlan: 'IP-30M', newPlan: 'IP-50M' }); // upgrade
    await fx.eventRepo.record({ contractId: 'ct-3', serviceCatalogId: fx.internetId, eventType: 'modified', actorName: 'Op', oldPlan: 'IP-50M', newPlan: 'IP-30M' }); // downgrade

    const res = await asUser(request(fx.app).get('/api/pppoe/activation-history?direction=upgrade'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].direction).toBe('upgrade');
    expect(res.body[0].oldPlan).toBe('IP-30M');
    expect(res.body[0].newPlan).toBe('IP-50M');
  });

  it('403 sin pppoe.read', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe/activation-history'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/pppoe/activation-history/operators — operadores DISTINCT de internet
// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/pppoe/activation-history/operators — distinct operators (internet-history)', () => {
  it('200 con array vacío cuando no hay eventos', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe/activation-history/operators'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('200 devuelve operadores DISTINCT {actorId, actorName} ordenados por actorName — NO sombreada por /:id', async () => {
    const fx = await buildApp();
    await fx.eventRepo.record({ contractId: 'ct-1', serviceCatalogId: fx.internetId, eventType: 'activated', actorId: 'a2', actorName: 'Zulema' });
    await fx.eventRepo.record({ contractId: 'ct-2', serviceCatalogId: fx.internetId, eventType: 'deactivated', actorId: 'a2', actorName: 'Zulema' });
    await fx.eventRepo.record({ contractId: 'ct-3', serviceCatalogId: fx.internetId, eventType: 'activated', actorId: 'a1', actorName: 'Ana' });

    const res = await asUser(request(fx.app).get('/api/pppoe/activation-history/operators'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { actorId: 'a1', actorName: 'Ana' },
      { actorId: 'a2', actorName: 'Zulema' },
    ]);
  });

  it('200 excluye operadores de TV/otros servicios y eventos sin actorId', async () => {
    const fx = await buildApp();
    const tv = await fx.catalogRepo.create({ name: 'TV', label: 'TV', sortOrder: 1 });
    await fx.eventRepo.record({ contractId: 'ct-1', serviceCatalogId: fx.internetId, eventType: 'activated', actorId: 'a1', actorName: 'OpInternet' });
    await fx.eventRepo.record({ contractId: 'ct-2', serviceCatalogId: tv.id, eventType: 'activated', actorId: 'a2', actorName: 'OpTv' });
    await fx.eventRepo.record({ contractId: 'ct-3', serviceCatalogId: fx.internetId, eventType: 'activated', actorName: 'SinId' });

    const res = await asUser(request(fx.app).get('/api/pppoe/activation-history/operators'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ actorId: 'a1', actorName: 'OpInternet' }]);
  });

  it('403 sin pppoe.read', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe/activation-history/operators'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });

  it('401 sin auth', async () => {
    const fx = await buildApp();
    const res = await request(fx.app).get('/api/pppoe/activation-history/operators');
    expect(res.status).toBe(401);
  });
});

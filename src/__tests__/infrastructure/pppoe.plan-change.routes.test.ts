/**
 * pppoe.plan-change.routes.test.ts — seam tests para PATCH /api/pppoe/:id
 * (pppoe-plan-change-history).
 *
 * TDD: escritos ANTES de la implementación.
 *
 * Cubre:
 *   - PATCH /api/pppoe/:id { profile, reason } → evento 'modified' con reason + actor + notes(old→new)
 *   - PATCH /api/pppoe/:id { profile } sin reason → evento 'modified' con reason=null
 *   - PATCH /api/pppoe/:id sin profile (ej. password) → sin evento 'modified'
 *   - El actor viene del usuario autenticado (actorName=username del token)
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

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

const NAS_ID = '1'; // mikrotik_api
const CONTRACT_ID = 'contract-pchg';
const USERNAME = 'testuser';

class EchoAuthProvider implements AuthProvider {
  constructor(private readonly fakeUser: User) {}
  async login() {
    return {
      user: this.fakeUser,
      cookieValue: 'x',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    return { ...this.fakeUser, id: token };
  }
}

interface Fixture {
  app: express.Express;
  pppoeRepo: InMemoryPppoeServiceRepository;
  eventRepo: InMemoryContractServiceEventRepository;
  catalogRepo: InMemoryServiceCatalogRepository;
  manageUserId: string;
  manageUsername: string;
}

async function buildApp(): Promise<Fixture> {
  // RBAC
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

  const managerRole = await roleRepo.create({ code: 'pppoe_manager', label: 'PPPoE Manager', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'pppoe', action: 'read' });
  const managePerm  = await permRepo.seed({ moduleCode: 'pppoe', action: 'manage' });
  const cutPerm     = await permRepo.seed({ moduleCode: 'pppoe', action: 'cut' });
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, cutPerm.id);

  const pwHash = await hasher.hash('pw');
  const manageUsername = 'op_juan';
  const manageUser = await userRepo.create({
    name: 'Operador Juan', email: 'juan@x.com', login: manageUsername, passwordHash: pwHash, status: 'active',
  });
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  // Repos
  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const routerGw    = new InMemoryRouterGateway();
  const nasRepo     = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const csRepo      = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const eventRepo   = new InMemoryContractServiceEventRepository();
  const ensure      = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);

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

  const fakeUser: User = { id: manageUser.id, username: manageUsername, email: 'juan@x.com', role: 'admin' };

  app.use('/api', createPppoeRouter(
    new EchoAuthProvider(fakeUser),
    undefined,
    requirePerm,
    new ListPppoeByContract(pppoeRepo),
    new CreatePppoeService(pppoeRepo, routerGw, nasRepo, orchestrator, ensure),
    new UpdatePppoeService(pppoeRepo, routerGw, nasRepo, orchestrator, catalogRepo, eventRepo),
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
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, eventRepo, catalogRepo, manageUserId: manageUser.id, manageUsername };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedCatalog(catalogRepo: InMemoryServiceCatalogRepository) {
  return catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
}

async function seedPppoe(
  pppoeRepo: InMemoryPppoeServiceRepository,
  overrides: Partial<{ profile: string; contractId: string | null }> = {},
) {
  return pppoeRepo.upsertByUsername({
    username: USERNAME,
    password: 'pw',
    profile: overrides.profile ?? 'IP-Air-30-10',
    nasId: NAS_ID,
    contractId: overrides.contractId !== undefined ? overrides.contractId : CONTRACT_ID,
    status: 'enabled',
  });
}

// ════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/pppoe/:id — pppoe-plan-change-history (route seam)', () => {
  it('{ profile, reason } → evento modified con reason + actor (username del token) + notes old→new', async () => {
    const fx = await buildApp();
    await seedCatalog(fx.catalogRepo);
    const row = await seedPppoe(fx.pppoeRepo);

    const res = await asUser(
      request(fx.app)
        .patch(`/api/pppoe/${row.id}`)
        .send({ profile: 'IP-Air-40-15', reason: 'upgrade comercial' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('modified');
    expect(events[0]!.reason).toBe('upgrade comercial');
    expect(events[0]!.actorName).toBe(fx.manageUsername); // username from JWT
    expect(events[0]!.actorId).toBe(fx.manageUserId);
    expect(events[0]!.notes).toBe('IP-Air-30-10 → IP-Air-40-15');
  });

  it('{ profile } sin reason → evento modified con reason=null', async () => {
    const fx = await buildApp();
    await seedCatalog(fx.catalogRepo);
    const row = await seedPppoe(fx.pppoeRepo);

    const res = await asUser(
      request(fx.app).patch(`/api/pppoe/${row.id}`).send({ profile: 'IP-Air-40-15' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('modified');
    expect(events[0]!.reason).toBeNull();
  });

  it('{ password } sin profile → sin evento de PLAN, pero SÍ audita el cambio (pppoe-change-audit)', async () => {
    const fx = await buildApp();
    await seedCatalog(fx.catalogRepo);
    const row = await seedPppoe(fx.pppoeRepo);

    const res = await asUser(
      request(fx.app).patch(`/api/pppoe/${row.id}`).send({ password: 'nueva123' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    // pppoe-change-audit (route seam): el cambio de password NO produce evento de PLAN, pero SÍ un
    // evento de auditoría changeKind 'password' con oldValue/newValue null (SEGURIDAD).
    expect(events.filter(e => e.changeKind == null)).toHaveLength(0);
    const pwEvents = events.filter(e => e.changeKind === 'password');
    expect(pwEvents).toHaveLength(1);
    expect(pwEvents[0]!.eventType).toBe('modified');
    expect(pwEvents[0]!.oldValue).toBeNull();
    expect(pwEvents[0]!.newValue).toBeNull();
  });

  it('profile igual al actual → sin evento modified', async () => {
    const fx = await buildApp();
    await seedCatalog(fx.catalogRepo);
    const row = await seedPppoe(fx.pppoeRepo, { profile: 'IP-Air-30-10' });

    const res = await asUser(
      request(fx.app).patch(`/api/pppoe/${row.id}`).send({ profile: 'IP-Air-30-10' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(0);
  });

  it('solo reason sin otro campo → 422 (at least one field required)', async () => {
    const fx = await buildApp();
    const row = await seedPppoe(fx.pppoeRepo);

    const res = await asUser(
      request(fx.app).patch(`/api/pppoe/${row.id}`).send({ reason: 'sin plan' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(422);
  });
});

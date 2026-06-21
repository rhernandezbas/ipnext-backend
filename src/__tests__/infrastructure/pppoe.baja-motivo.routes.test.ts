/**
 * pppoe.baja-motivo.routes.test.ts — seam tests para la propagación del `reason`
 * en las rutas de baja/desasociar PPPoE (pppoe-baja-motivo).
 *
 * TDD: escrito ANTES de la implementación.
 *
 * Cubre:
 *   - DELETE /api/pppoe/:id con body { reason } → evento 'deactivated' con ese reason
 *   - DELETE /api/pppoe/:id sin body → funciona igual (back-compat), reason=null
 *   - DELETE /api/contracts/:contractId/pppoe/:pppoeId con body { reason } → evento 'deactivated' con reason
 *   - DELETE /api/contracts/:contractId/pppoe/:pppoeId sin body → funciona igual, reason=null
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

const NAS_ID      = '1';
const CONTRACT_ID = 'contract-1';

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
  csRepo: InMemoryContractServiceRepository;
  catalogRepo: InMemoryServiceCatalogRepository;
  manageUserId: string;
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
  const manageUser = await userRepo.create({
    name: 'manager', email: 'manager@x.com', login: 'manager', passwordHash: pwHash, status: 'active',
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
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, eventRepo, csRepo, catalogRepo, manageUserId: manageUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

/** Seeds an INTERNET contract-service so ensureInternet has a transition to make */
async function seedInternetLine(
  csRepo: InMemoryContractServiceRepository,
  catalogRepo: InMemoryServiceCatalogRepository,
  contractId: string,
) {
  const catalog = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
  csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
  await csRepo.add({ contractId, serviceCatalogId: catalog.id });
  return catalog;
}

// ════════════════════════════════════════════════════════════════════════════════
// DELETE /api/pppoe/:id — baja con motivo
// ════════════════════════════════════════════════════════════════════════════════

describe('DELETE /api/pppoe/:id — propagación de reason (pppoe-baja-motivo)', () => {
  it('body { reason } → evento deactivated con ese reason', async () => {
    const fx = await buildApp();
    await seedInternetLine(fx.csRepo, fx.catalogRepo, CONTRACT_ID);
    const row = await fx.pppoeRepo.upsertByUsername({
      username: 'user1', password: 'p', nasId: NAS_ID, contractId: CONTRACT_ID, status: 'enabled',
    });

    const res = await asUser(
      request(fx.app).delete(`/api/pppoe/${row.id}`).send({ reason: 'baja voluntaria' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(204);
    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.reason).toBe('baja voluntaria');
  });

  it('sin body → funciona (back-compat), sin reason', async () => {
    const fx = await buildApp();
    await seedInternetLine(fx.csRepo, fx.catalogRepo, CONTRACT_ID);
    const row = await fx.pppoeRepo.upsertByUsername({
      username: 'user2', password: 'p', nasId: NAS_ID, contractId: CONTRACT_ID, status: 'enabled',
    });

    const res = await asUser(
      request(fx.app).delete(`/api/pppoe/${row.id}`),
      fx.manageUserId,
    );

    expect(res.status).toBe(204);
    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    // El evento existe, pero sin reason (null)
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.reason).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// DELETE /api/contracts/:contractId/pppoe/:pppoeId — desasociar con motivo
// ════════════════════════════════════════════════════════════════════════════════

describe('DELETE /api/contracts/:contractId/pppoe/:pppoeId — propagación de reason (pppoe-baja-motivo)', () => {
  it('body { reason } → evento deactivated con ese reason', async () => {
    const fx = await buildApp();
    await seedInternetLine(fx.csRepo, fx.catalogRepo, CONTRACT_ID);
    const row = await fx.pppoeRepo.upsertByUsername({
      username: 'user3', password: 'p', nasId: NAS_ID, contractId: CONTRACT_ID, status: 'enabled',
    });

    const res = await asUser(
      request(fx.app)
        .delete(`/api/contracts/${CONTRACT_ID}/pppoe/${row.id}`)
        .send({ reason: 'cambio de plan' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.contractId).toBeNull();

    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('deactivated');
    expect(events[0]!.reason).toBe('cambio de plan');
  });

  it('sin body → funciona (back-compat), reason=null', async () => {
    const fx = await buildApp();
    await seedInternetLine(fx.csRepo, fx.catalogRepo, CONTRACT_ID);
    const row = await fx.pppoeRepo.upsertByUsername({
      username: 'user4', password: 'p', nasId: NAS_ID, contractId: CONTRACT_ID, status: 'enabled',
    });

    const res = await asUser(
      request(fx.app).delete(`/api/contracts/${CONTRACT_ID}/pppoe/${row.id}`),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.reason).toBeNull();
  });
});

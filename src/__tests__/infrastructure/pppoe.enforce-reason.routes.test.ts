/**
 * pppoe.enforce-reason.routes.test.ts — seam tests para la propagación del `reason`
 * en POST /api/pppoe/:id/enforce (pppoe-corte-individual).
 *
 * TDD: escrito ANTES de la implementación.
 *
 * Cubre:
 *   - POST /api/pppoe/:id/enforce con body { action, reason } → evento 'reduced' con ese reason
 *   - POST /api/pppoe/:id/enforce con body { action } sin reason → funciona (back-compat), reason=null
 *   - POST /api/pppoe/:id/enforce block → evento 'blocked'
 *   - POST /api/pppoe/:id/enforce restore → evento 'restored'
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
import { RecordPppoeEnforceEvent } from '@application/use-cases/RecordPppoeEnforceEvent';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { PreviewEnforcement } from '@application/use-cases/PreviewEnforcement';
import { RunBulkEnforcement } from '@application/use-cases/RunBulkEnforcement';
import { ServiceCutRunner } from '@infrastructure/scheduling/ServiceCutRunner';
import { IngestPppoeFromNas } from '@application/use-cases/IngestPppoeFromNas';
import { AssociatePppoeToContract } from '@application/use-cases/AssociatePppoeToContract';
import { GetPppoeCredentials } from '@application/use-cases/GetPppoeCredentials';
import { ListUnassignedPppoe } from '@application/use-cases/ListUnassignedPppoe';
import { DeassociatePppoeFromContract } from '@application/use-cases/DeassociatePppoeFromContract';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

// InMemoryNasRepository preseeds id='1' con ip='192.168.1.1'
const NAS_ID = '1';
const NAS_IP = '192.168.1.1';
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
  catalogRepo: InMemoryServiceCatalogRepository;
  cutUserId: string;
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

  const cutterRole = await roleRepo.create({ code: 'pppoe_cutter', label: 'PPPoE Cutter', isSystem: false });
  const cutPerm    = await permRepo.seed({ moduleCode: 'pppoe', action: 'cut' });
  await rolePermRepo.grant(cutterRole.id, cutPerm.id);

  const pwHash  = await hasher.hash('pw');
  const cutUser = await userRepo.create({
    name: 'cutter', email: 'cutter@x.com', login: 'cutter', passwordHash: pwHash, status: 'active',
  });
  await userRoleRepo.assign(cutUser.id, cutterRole.id);

  // Repos
  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const routerGw    = new InMemoryRouterGateway();
  const nasRepo     = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const csRepo      = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const eventRepo   = new InMemoryContractServiceEventRepository();

  const ensure    = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);
  const recordEnforceEvent = new RecordPppoeEnforceEvent(catalogRepo, eventRepo);

  const batchRepo = new InMemoryServiceCutBatchRepository();
  const lock      = new InMemoryDistributedLock();

  const enforcement = new RouterOsEnforcementAdapter(routerGw, 'IP-REDUCCION');
  const enforce  = new EnforcePppoeService(pppoeRepo, enforcement, nasRepo, recordEnforceEvent);
  const preview  = new PreviewEnforcement(pppoeRepo);
  const bulk     = new RunBulkEnforcement(pppoeRepo, enforce, batchRepo, { throttleMs: 0 });
  const runner   = new ServiceCutRunner(bulk, batchRepo, lock);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

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
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, eventRepo, catalogRepo, cutUserId: cutUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedPppoeAndCatalog(fx: Fixture) {
  // seed catálogo INTERNET
  const catalog = await fx.catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });

  // seed PPPoE activo con contractId
  const pppoe = await fx.pppoeRepo.upsertByUsername({
    username: 'cli1',
    password: 'pw',
    nasId: NAS_ID,
    contractId: CONTRACT_ID,
    status: 'enabled',
    enforcedState: 'active',
  });

  return { pppoe, catalog };
}

describe('POST /api/pppoe/:id/enforce — propagación de reason (pppoe-corte-individual)', () => {
  it('body { action: reduce, reason } → 200 + evento reduced con ese reason', async () => {
    const fx = await buildApp();
    const { pppoe } = await seedPppoeAndCatalog(fx);

    const res = await asUser(
      request(fx.app)
        .post(`/api/pppoe/${pppoe.id}/enforce`)
        .send({ action: 'reduce', reason: 'deuda pendiente' }),
      fx.cutUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.enforcedState).toBe('reduced');

    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('reduced');
    expect(events[0]!.reason).toBe('deuda pendiente');
  });

  it('body { action: block, reason } → evento blocked con ese reason', async () => {
    const fx = await buildApp();
    const { pppoe } = await seedPppoeAndCatalog(fx);

    const res = await asUser(
      request(fx.app)
        .post(`/api/pppoe/${pppoe.id}/enforce`)
        .send({ action: 'block', reason: 'mora extendida' }),
      fx.cutUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.enforcedState).toBe('blocked');

    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('blocked');
    expect(events[0]!.reason).toBe('mora extendida');
  });

  it('body { action: restore, reason } → evento restored con ese reason', async () => {
    const fx = await buildApp();
    const pppoe = await fx.pppoeRepo.upsertByUsername({
      username: 'cli-blocked',
      password: 'pw',
      nasId: NAS_ID,
      contractId: CONTRACT_ID,
      status: 'enabled',
      enforcedState: 'blocked',
    });
    await fx.catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });

    const res = await asUser(
      request(fx.app)
        .post(`/api/pppoe/${pppoe.id}/enforce`)
        .send({ action: 'restore', reason: 'pago recibido' }),
      fx.cutUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.enforcedState).toBe('active');

    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('restored');
    expect(events[0]!.reason).toBe('pago recibido');
  });

  it('body { action } sin reason → 200 (back-compat), sin event reason', async () => {
    const fx = await buildApp();
    const { pppoe } = await seedPppoeAndCatalog(fx);

    const res = await asUser(
      request(fx.app)
        .post(`/api/pppoe/${pppoe.id}/enforce`)
        .send({ action: 'reduce' }),
      fx.cutUserId,
    );

    expect(res.status).toBe(200);
    const events = await fx.eventRepo.listByContract(CONTRACT_ID);
    // Puede haber evento o no, pero si hay, reason es null
    if (events.length > 0) {
      expect(events[0]!.reason).toBeNull();
    }
  });
});

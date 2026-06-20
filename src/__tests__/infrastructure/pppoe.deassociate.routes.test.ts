/**
 * pppoe.deassociate.routes.test.ts — seam test para DELETE /api/contracts/:contractId/pppoe/:pppoeId.
 *
 * TDD: escrito ANTES de la implementación.
 *
 * Cubre:
 *   - 401 sin auth
 *   - 403 sin permiso pppoe.manage
 *   - 200 con DTO huérfano (contractId=null, status=enabled)
 *   - 404 PPPoE no existe
 *   - 404 PPPoE no pertenece al contrato (ownership)
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

const NAS_ID = '1';
const CONTRACT_ID = 'contract-1';

interface Fixture {
  app: express.Express;
  pppoeRepo: InMemoryPppoeServiceRepository;
  readUserId: string;
  manageUserId: string;
  noPermUserId: string;
}

async function buildApp(): Promise<Fixture> {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher = new InMemoryPasswordHasher();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

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
  const managerRole = await roleRepo.create({ code: 'pppoe_manager', label: 'PPPoE Manager', isSystem: false });
  const readPerm   = await permRepo.seed({ moduleCode: 'pppoe', action: 'read' });
  const managePerm = await permRepo.seed({ moduleCode: 'pppoe', action: 'manage' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser = await mkUser('reader');
  const manageUser = await mkUser('manager');
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(readUser.id, readerRole.id);
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const routerGw  = new InMemoryRouterGateway();
  const nasRepo   = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const csRepo    = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const ensure    = new EnsureInternetContractService(csRepo, catalogRepo);

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

  return {
    app,
    pppoeRepo,
    readUserId: readUser.id,
    manageUserId: manageUser.id,
    noPermUserId: noPermUser.id,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

describe('DELETE /api/contracts/:contractId/pppoe/:pppoeId', () => {
  it('401 sin auth', async () => {
    const { app } = await buildApp();
    const res = await request(app).delete(`/api/contracts/${CONTRACT_ID}/pppoe/some-id`);
    expect(res.status).toBe(401);
  });

  it('403 con pppoe.read solo (requiere pppoe.manage)', async () => {
    const fx = await buildApp();
    const s = await fx.pppoeRepo.upsertByUsername({ username: 'u', password: 'p', nasId: NAS_ID, contractId: CONTRACT_ID });
    const res = await asUser(request(fx.app).delete(`/api/contracts/${CONTRACT_ID}/pppoe/${s.id}`), fx.readUserId);
    expect(res.status).toBe(403);
  });

  it('200 con DTO huérfano (contractId=null, status=enabled)', async () => {
    const fx = await buildApp();
    const s = await fx.pppoeRepo.upsertByUsername({
      username: 'juan', password: 'p', nasId: NAS_ID, contractId: CONTRACT_ID, status: 'enabled',
    });
    const res = await asUser(
      request(fx.app).delete(`/api/contracts/${CONTRACT_ID}/pppoe/${s.id}`),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.contractId).toBeNull();
    expect(res.body.status).toBe('enabled');
    expect(res.body.password).toBeUndefined(); // DTO nunca expone password
  });

  it('404 PPPoE no existe', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).delete(`/api/contracts/${CONTRACT_ID}/pppoe/no-existe`),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PPPOE_NOT_FOUND');
  });

  it('404 PPPoE no pertenece al contrato (ownership check)', async () => {
    const fx = await buildApp();
    const s = await fx.pppoeRepo.upsertByUsername({
      username: 'otro', password: 'p', nasId: NAS_ID, contractId: 'otro-contrato', status: 'enabled',
    });
    const res = await asUser(
      request(fx.app).delete(`/api/contracts/${CONTRACT_ID}/pppoe/${s.id}`),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PPPOE_NOT_FOUND');
  });
});

describe('POST /api/contracts/:contractId/pppoe — guard #4 (409 contrato ocupado)', () => {
  it('409 PPPOE_CONTRACT_ALREADY_HAS_SERVICE cuando el contrato ya tiene PPPoE enabled', async () => {
    const fx = await buildApp();
    // Seed: contrato con PPPoE enabled
    await fx.pppoeRepo.upsertByUsername({ username: 'existente', password: 'p', nasId: NAS_ID, contractId: CONTRACT_ID, status: 'enabled' });

    const res = await asUser(
      request(fx.app).post(`/api/contracts/${CONTRACT_ID}/pppoe`).send({ username: 'nuevo', password: 'pw', nasId: NAS_ID }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_CONTRACT_ALREADY_HAS_SERVICE');
  });
});

describe('POST /api/pppoe/:id/associate — guard #4 (409 contrato ocupado)', () => {
  it('409 PPPOE_CONTRACT_ALREADY_HAS_SERVICE cuando el contrato ya tiene PPPoE enabled', async () => {
    const fx = await buildApp();
    // Contrato C1 ya tiene un PPPoE enabled
    await fx.pppoeRepo.upsertByUsername({ username: 'ocupado', password: 'p', nasId: NAS_ID, contractId: 'C1', status: 'enabled' });
    // Nuevo huérfano que quiere asociarse
    const orphan = await fx.pppoeRepo.upsertByUsername({ username: 'orphan', password: 'p', nasId: NAS_ID, contractId: null });

    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${orphan.id}/associate`).send({ contractId: 'C1' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_CONTRACT_ALREADY_HAS_SERVICE');
  });
});

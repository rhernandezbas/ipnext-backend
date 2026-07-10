/**
 * pppoe.transfer.routes.test.ts — seam test para POST /api/pppoe/:id/transfer (service-transfer W2).
 *
 * TDD: escrito ANTES de la implementación. Use case REAL + repos in-memory (lección #28).
 *
 * Wire contract:
 *   200 as-is happy · 207 recreate PARCIAL (nuevo vivo, viejo pendiente de borrar) ·
 *   400 VALIDATION_ERROR (sin reason en as-is / mode inválido — pineado por el spec PPPOE-1,
 *   espejo del wire de transfer-tv W1, NO el 422 zod de las rutas vecinas) ·
 *   401 sin auth · 403 sin pppoe.transfer (fail-closed, RBAC-1) ·
 *   404 CONTRACT_NOT_FOUND (statusMap del errorHandler global) ·
 *   409 PPPOE_CONTRACT_ALREADY_HAS_SERVICE (destino ocupado) ·
 *   "no cuelga" (RBAC-2): error tipado del orchestrator en recreate → status inmediato
 *   (502 ORCHESTRATOR_UNREACHABLE via errorHandler), jamás una request colgada.
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
import { TerminatePppoeService } from '@application/use-cases/TerminatePppoeService';
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
import { TransferPppoe } from '@application/use-cases/TransferPppoe';

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

// NAS '3' del InMemoryNasRepository = radius_orchestrator.
const RADIUS_NAS = '3';

const CONTRACTS: Record<string, { clientId: string; clientName: string | null }> = {
  'C-A': { clientId: 'cli-A', clientName: 'Perez Juan' },
  'C-B': { clientId: 'cli-B', clientName: 'Gomez Ana' },
};

interface Fixture {
  app: express.Express;
  pppoeRepo: InMemoryPppoeServiceRepository;
  eventRepo: InMemoryContractServiceEventRepository;
  transferUserId: string;
  manageUserId: string;
}

async function buildApp(opts: { orchestratorUnreachable?: string[] } = {}): Promise<Fixture> {
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

  const managerRole = await roleRepo.create({ code: 'pppoe_manager', label: 'PPPoE Manager', isSystem: false });
  const transferRole = await roleRepo.create({ code: 'pppoe_transfer', label: 'PPPoE Transfer', isSystem: false });
  const managePerm = await permRepo.seed({ moduleCode: 'pppoe', action: 'manage' });
  const transferPerm = await permRepo.seed({ moduleCode: 'pppoe', action: 'transfer' });
  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(transferRole.id, transferPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const manageUser = await mkUser('manager');
  const transferUser = await mkUser('transferer');
  await userRoleRepo.assign(manageUser.id, managerRole.id);
  await userRoleRepo.assign(transferUser.id, transferRole.id);

  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const routerGw = new InMemoryRouterGateway();
  const nasRepo = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway({ unreachable: opts.orchestratorUnreachable ?? [] });
  const csRepo = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const catalog = await catalogRepo.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
  csRepo.catalog[catalog.id] = { name: 'INTERNET', label: 'Internet' };
  const eventRepo = new InMemoryContractServiceEventRepository();
  const ensure = new EnsureInternetContractService(csRepo, catalogRepo);

  const createSvc = new CreatePppoeService(pppoeRepo, routerGw, nasRepo, orchestrator, ensure);
  const terminateSvc = new TerminatePppoeService(pppoeRepo, orchestrator, routerGw, nasRepo, ensure);
  const contractLookup = {
    findById: async (id: string) => (id in CONTRACTS ? { id, ...CONTRACTS[id]! } : null),
  };
  const transferPppoe = new TransferPppoe(
    pppoeRepo, contractLookup, createSvc, terminateSvc, ensure, catalogRepo, eventRepo,
  );

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
    createSvc,
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
    terminateSvc,
    undefined, // getPppoeCallerId
    undefined, // listAllPppoeServices
    undefined, // listInternetServiceHistory
    undefined, // listInternetActivationOperators
    undefined, // createPppoeStandalone
    undefined, // renamePppoeUsername
    undefined, // movePppoeToNas
    undefined, // listPppoeNasMoveEvents
    undefined, // bulkChangePppoePlan
    undefined, // listAllPppoeServiceIds
    transferPppoe,
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, eventRepo, transferUserId: transferUser.id, manageUserId: manageUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedSource(fx: Fixture) {
  return fx.pppoeRepo.upsertByUsername({
    username: 'juanp', password: 'pw', profile: 'IP-50', nasId: RADIUS_NAS, contractId: 'C-A', status: 'enabled',
  });
}

let warnSpy: jest.SpyInstance;
beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); });

describe('POST /api/pppoe/:id/transfer — auth + RBAC (RBAC-1)', () => {
  it('401 sin auth', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/pppoe/x/transfer').send({ targetContractId: 'C-B', mode: 'as-is', reason: 'r' });
    expect(res.status).toBe(401);
  });

  it('403 con pppoe.manage solo (requiere pppoe.transfer, fail-closed) y sin efectos', async () => {
    const fx = await buildApp();
    const s = await seedSource(fx);
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({ targetContractId: 'C-B', mode: 'as-is', reason: 'r' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(403);
    expect((await fx.pppoeRepo.findByUsername('juanp'))!.contractId).toBe('C-A');
  });
});

describe('POST /api/pppoe/:id/transfer — as-is', () => {
  it('200 happy: resultado del use case y fila movida', async () => {
    const fx = await buildApp();
    const s = await seedSource(fx);
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({
        targetContractId: 'C-B', mode: 'as-is', reason: 'sin acceso a la antena',
      }),
      fx.transferUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'as-is', oldContractId: 'C-A', newContractId: 'C-B', oldUsername: 'juanp',
    });
    expect((await fx.pppoeRepo.findByUsername('juanp'))!.contractId).toBe('C-B');
    // Eventos out/in grabados por el seam completo.
    expect(fx.eventRepo.all().map(e => e.changeKind)).toEqual(['transfer-out', 'transfer-in']);
  });

  it('400 VALIDATION_ERROR sin reason (as-is) y sin efectos', async () => {
    const fx = await buildApp();
    const s = await seedSource(fx);
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({ targetContractId: 'C-B', mode: 'as-is' }),
      fx.transferUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect((await fx.pppoeRepo.findByUsername('juanp'))!.contractId).toBe('C-A');
    expect(fx.eventRepo.all()).toHaveLength(0);
  });

  it('400 VALIDATION_ERROR con mode inválido', async () => {
    const fx = await buildApp();
    const s = await seedSource(fx);
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({ targetContractId: 'C-B', mode: 'yolo', reason: 'r' }),
      fx.transferUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR con recreate sin newPppoe', async () => {
    const fx = await buildApp();
    const s = await seedSource(fx);
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({ targetContractId: 'C-B', mode: 'recreate' }),
      fx.transferUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('409 PPPOE_CONTRACT_ALREADY_HAS_SERVICE cuando el destino ya tiene PPPoE enabled', async () => {
    const fx = await buildApp();
    const s = await seedSource(fx);
    await fx.pppoeRepo.upsertByUsername({
      username: 'ocupado', password: 'p', nasId: RADIUS_NAS, contractId: 'C-B', status: 'enabled',
    });
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({ targetContractId: 'C-B', mode: 'as-is', reason: 'r' }),
      fx.transferUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_CONTRACT_ALREADY_HAS_SERVICE');
  });

  it('404 CONTRACT_NOT_FOUND cuando el contrato destino no existe (statusMap del errorHandler)', async () => {
    const fx = await buildApp();
    const s = await seedSource(fx);
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({ targetContractId: 'ghost', mode: 'as-is', reason: 'r' }),
      fx.transferUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('404 PPPOE_NOT_FOUND cuando el PPPoE no existe', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe/ghost/transfer').send({ targetContractId: 'C-B', mode: 'as-is', reason: 'r' }),
      fx.transferUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PPPOE_NOT_FOUND');
  });
});

describe('POST /api/pppoe/:id/transfer — recreate', () => {
  const NEW_PPPOE = {
    username: 'anag', password: 'pw2', profile: 'IP-100', nasId: RADIUS_NAS, ipTypePreference: 'cgnat',
  };

  it('200 happy: nuevo creado en el destino, viejo borrado', async () => {
    const fx = await buildApp();
    const s = await seedSource(fx);
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({
        targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE,
      }),
      fx.transferUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'recreate', oldContractId: 'C-A', newContractId: 'C-B',
      oldUsername: 'juanp', newUsername: 'anag',
    });
    expect(await fx.pppoeRepo.findByUsername('juanp')).toBeNull();
    expect((await fx.pppoeRepo.findByUsername('anag'))!.contractId).toBe('C-B');
  });

  it('FIX-4 — 409 PPPOE_CONTRACT_ALREADY_HAS_SERVICE en modo recreate (destino ocupado; antes solo cubierto en as-is)', async () => {
    const fx = await buildApp();
    const s = await seedSource(fx);
    await fx.pppoeRepo.upsertByUsername({
      username: 'ocupado', password: 'p', nasId: RADIUS_NAS, contractId: 'C-B', status: 'enabled',
    });
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({
        targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE,
      }),
      fx.transferUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_CONTRACT_ALREADY_HAS_SERVICE');
    // Cero efectos: el nuevo jamás nació (el guard corre ANTES del create) y el viejo quedó intacto.
    expect(await fx.pppoeRepo.findByUsername('anag')).toBeNull();
    expect((await fx.pppoeRepo.findByUsername('juanp'))!.contractId).toBe('C-A');
    expect(fx.eventRepo.all()).toHaveLength(0);
  });

  it('207 recreate PARCIAL: terminate del viejo falla → nuevo vivo, viejo pendiente de borrar', async () => {
    // 'juanp' unreachable en el orchestrator: createUser('anag') OK, deleteUser('juanp') explota.
    const fx = await buildApp({ orchestratorUnreachable: ['juanp'] });
    const s = await seedSource(fx);
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({
        targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE,
      }),
      fx.transferUserId,
    );
    expect(res.status).toBe(207);
    expect(res.body.partial).toBe(true);
    expect(res.body.newUsername).toBe('anag');
    // Nuevo vivo, viejo todavía existe (retry direccionado = DELETE /pppoe/:id del viejo).
    expect((await fx.pppoeRepo.findByUsername('anag'))!.contractId).toBe('C-B');
    expect(await fx.pppoeRepo.findByUsername('juanp')).not.toBeNull();
  });

  it('MEDIUM-4: retry tras create parcial → 409 PPPOE_TRANSFER_PENDING_RESIDUE con el id de la fila pending', async () => {
    // 'anag' unreachable: el primer intento deja la fila pending en el destino y responde 502.
    const fx = await buildApp({ orchestratorUnreachable: ['anag'] });
    const s = await seedSource(fx);
    const first = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({
        targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE,
      }),
      fx.transferUserId,
    );
    expect(first.status).toBe(502);
    const pending = await fx.pppoeRepo.findByUsername('anag');
    expect(pending!.status).toBe('pending');

    // Retry: NO el 409 USERNAME_TAKEN engañoso — el error propio con el retry direccionado.
    const second = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({
        targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE,
      }),
      fx.transferUserId,
    );
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PPPOE_TRANSFER_PENDING_RESIDUE');
    expect(second.body.error).toContain(pending!.id);
  });

  it('no cuelga (RBAC-2): orchestrator inalcanzable en el create → 502 inmediato via errorHandler', async () => {
    const fx = await buildApp({ orchestratorUnreachable: ['anag'] });
    const s = await seedSource(fx);
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/transfer`).send({
        targetContractId: 'C-B', mode: 'recreate', newPppoe: NEW_PPPOE,
      }),
      fx.transferUserId,
    );
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ORCHESTRATOR_UNREACHABLE');
    // El viejo quedó intacto (create-first abortó ANTES del terminate).
    expect((await fx.pppoeRepo.findByUsername('juanp'))!.contractId).toBe('C-A');
  });
});

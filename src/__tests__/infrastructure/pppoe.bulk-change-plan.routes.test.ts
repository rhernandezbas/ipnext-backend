/**
 * pppoe.bulk-change-plan.routes.test.ts — route seam tests (tasks 4.1, 4.2)
 * TDD: route → use case REAL → repos in-memory. No mocks on use cases (lesson #28).
 *
 * Routes under test: POST /api/pppoe/bulk/change-plan
 *
 * Covers:
 *   - bulk feliz → 200 { ok, failed }
 *   - ítem que falla → 200 (best-effort) con failed[] populated
 *   - plan inexistente → 422 (fail-fast)
 *   - sin permiso pppoe.manage → 403
 *   - body vacío / ids vacío → 400 (Zod validation)
 *   - body con ids > 200 → 422 (BulkTooLargeError)
 *   - composition: route vive (no 404)
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
import { BulkChangePppoePlan } from '@application/use-cases/BulkChangePppoePlan';
import { ChangePppoePlanService } from '@application/services/ChangePppoePlanService';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

// NAS '3' = radius_orchestrator in InMemoryNasRepository
const ORCH_NAS_ID = '3';

class EchoAuthProvider implements AuthProvider {
  constructor(private readonly user: User) {}
  async login() {
    return {
      user: this.user,
      cookieValue: 'x',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    return { ...this.user, id: token };
  }
}

interface Fixture {
  app: express.Express;
  pppoeRepo: InMemoryPppoeServiceRepository;
  planRepo: InMemoryPlanRepository;
  manageUserId: string;
  noPermUserId: string;
}

interface BuildAppOptions {
  /** W3 fix-wave: usernames for which the orchestrator throws OrchestratorUnreachableError. */
  unreachableUsernames?: string[];
  /** W1 fix-wave: override the real BulkChangePppoePlan use case with a fake (e.g. one that
   * rejects unexpectedly) to test the route's error handling in isolation. */
  bulkUseCaseOverride?: BulkChangePppoePlan;
}

async function buildApp(opts?: BuildAppOptions): Promise<Fixture> {
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

  const managerRole = await roleRepo.create({ code: 'pppoe_manager', label: 'PPPoE Manager', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'pppoe', action: 'read' });
  const managePerm  = await permRepo.seed({ moduleCode: 'pppoe', action: 'manage' });
  const cutPerm     = await permRepo.seed({ moduleCode: 'pppoe', action: 'cut' });
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, cutPerm.id);

  const pwHash = await hasher.hash('pw');
  const manageUser = await userRepo.create({ name: 'Manager', email: 'm@x.com', login: 'm', passwordHash: pwHash, status: 'active' });
  const noPermUser = await userRepo.create({ name: 'NoPerm',  email: 'n@x.com', login: 'n', passwordHash: pwHash, status: 'active' });
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const routerGw    = new InMemoryRouterGateway();
  const nasRepo     = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway({ unreachable: opts?.unreachableUsernames ?? [] });
  const planRepo    = new InMemoryPlanRepository();
  const csRepo      = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const eventRepo   = new InMemoryContractServiceEventRepository();
  const ensure      = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const batchRepo = new InMemoryServiceCutBatchRepository();
  const lock      = new InMemoryDistributedLock();
  const enforce   = new EnforcePppoeService(pppoeRepo, new RouterOsEnforcementAdapter(routerGw, 'IP-REDUCCION'), nasRepo);
  const preview   = new PreviewEnforcement(pppoeRepo);
  const bulkEnf   = new RunBulkEnforcement(pppoeRepo, enforce, batchRepo, { throttleMs: 0 });
  const runner    = new ServiceCutRunner(bulkEnf, batchRepo, lock);

  const changePlanSvc   = new ChangePppoePlanService(pppoeRepo, routerGw, nasRepo, orchestrator, catalogRepo, eventRepo);
  const bulkChangePlan  = opts?.bulkUseCaseOverride
    ?? new BulkChangePppoePlan(pppoeRepo, planRepo, nasRepo, changePlanSvc, { throttleMs: 0 });

  const fakeManageUser: User = { id: manageUser.id, username: 'm', email: 'm@x.com', role: 'admin' };

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createPppoeRouter(
    new EchoAuthProvider(fakeManageUser),
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
    undefined, // createPppoeStandalone
    undefined, // renamePppoeUsername
    undefined, // movePppoeToNas
    undefined, // listPppoeNasMoveEvents
    bulkChangePlan,
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, planRepo, manageUserId: manageUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedService(
  pppoeRepo: InMemoryPppoeServiceRepository,
  overrides: { username?: string; contractId?: string | null } = {},
) {
  return pppoeRepo.upsertByUsername({
    username:   overrides.username ?? 'svc@test',
    password:   'pw',
    profile:    'IP-30M',
    nasId:      ORCH_NAS_ID,
    contractId: overrides.contractId !== undefined ? overrides.contractId : 'ctr-1',
    status:     'enabled',
  });
}

async function seedPlan(planRepo: InMemoryPlanRepository, code = 'IP-50M') {
  return planRepo.upsertByCode({ code, name: code, category: 'Internet', downloadKbps: 50000, uploadKbps: 10000 });
}

// ════════════════════════════════════════════════════════════════════════════
describe('POST /api/pppoe/bulk/change-plan — composition (route exists)', () => {
  it('route exists — not 404', async () => {
    const fx = await buildApp();
    await seedPlan(fx.planRepo);
    const s = await seedService(fx.pppoeRepo);

    const res = await asUser(
      request(fx.app).post('/api/pppoe/bulk/change-plan').send({ ids: [s.id], profile: 'IP-50M' }),
      fx.manageUserId,
    );
    expect(res.status).not.toBe(404);
  });
});

describe('POST /api/pppoe/bulk/change-plan — bulk feliz', () => {
  it('3 servicios → 200 { ok: [3 ids], failed: [] }', async () => {
    const fx = await buildApp();
    await seedPlan(fx.planRepo);
    const s1 = await seedService(fx.pppoeRepo, { username: 's1@test', contractId: 'ctr-1' });
    const s2 = await seedService(fx.pppoeRepo, { username: 's2@test', contractId: 'ctr-2' });
    const s3 = await seedService(fx.pppoeRepo, { username: 's3@test', contractId: 'ctr-3' });

    const res = await asUser(
      request(fx.app).post('/api/pppoe/bulk/change-plan').send({ ids: [s1.id, s2.id, s3.id], profile: 'IP-50M' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toHaveLength(3);
    expect(res.body.failed).toHaveLength(0);
    expect(res.body.ok).toContain(s1.id);
  });

  it('body with reason is accepted', async () => {
    const fx = await buildApp();
    await seedPlan(fx.planRepo);
    const s = await seedService(fx.pppoeRepo);

    const res = await asUser(
      request(fx.app).post('/api/pppoe/bulk/change-plan').send({ ids: [s.id], profile: 'IP-50M', reason: 'promo' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /api/pppoe/bulk/change-plan — validaciones', () => {
  it('ids vacío → 422 (Zod min(1))', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe/bulk/change-plan').send({ ids: [], profile: 'IP-50M' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
  });

  it('body sin ids → 422', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe/bulk/change-plan').send({ profile: 'IP-50M' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
  });

  it('ids > 200 → 422 (BulkTooLargeError)', async () => {
    const fx = await buildApp();
    await seedPlan(fx.planRepo);
    const ids = Array.from({ length: 201 }, (_, i) => `id-${i}`);

    const res = await asUser(
      request(fx.app).post('/api/pppoe/bulk/change-plan').send({ ids, profile: 'IP-50M' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('BULK_TOO_LARGE');
  });

  it('plan inexistente → 422 (PlanNotFoundForBulkError, fail-fast)', async () => {
    const fx = await buildApp();
    const s = await seedService(fx.pppoeRepo);

    const res = await asUser(
      request(fx.app).post('/api/pppoe/bulk/change-plan').send({ ids: [s.id], profile: 'PLAN-NO-EXISTE' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PLAN_NOT_FOUND');
  });
});

describe('POST /api/pppoe/bulk/change-plan — autenticación y permisos', () => {
  it('sin token → 401', async () => {
    const fx = await buildApp();
    const res = await request(fx.app).post('/api/pppoe/bulk/change-plan').send({ ids: ['x'], profile: 'IP-50M' });
    expect(res.status).toBe(401);
  });

  it('sin permiso pppoe.manage → 403', async () => {
    const fx = await buildApp();

    const res = await asUser(
      request(fx.app).post('/api/pppoe/bulk/change-plan').send({ ids: ['x'], profile: 'IP-50M' }),
      fx.noPermUserId,
    );
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// W3 fix-wave — seam de ruta que faltaba: best-effort a nivel HTTP (no solo a nivel use case).
describe('POST /api/pppoe/bulk/change-plan — best-effort a nivel HTTP (W3)', () => {
  it('W3(a): un ítem falla (orchestrator caído) → 200 con failed[] poblado y ok[] con los que sí', async () => {
    const fx = await buildApp({ unreachableUsernames: ['s2@test'] });
    await seedPlan(fx.planRepo);
    const s1 = await seedService(fx.pppoeRepo, { username: 's1@test', contractId: 'ctr-1' });
    const s2 = await seedService(fx.pppoeRepo, { username: 's2@test', contractId: 'ctr-2' });
    const s3 = await seedService(fx.pppoeRepo, { username: 's3@test', contractId: 'ctr-3' });

    const res = await asUser(
      request(fx.app).post('/api/pppoe/bulk/change-plan').send({ ids: [s1.id, s2.id, s3.id], profile: 'IP-50M' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toHaveLength(2);
    expect(res.body.ok).toContain(s1.id);
    expect(res.body.ok).toContain(s3.id);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe(s2.id);
    expect(res.body.failed[0].username).toBe('s2@test');
    expect(res.body.failed[0].error).toBeTruthy();
  });

  it('W3(b): id inexistente en el lote → 200 con ese id en failed[] (best-effort, no aborta)', async () => {
    const fx = await buildApp();
    await seedPlan(fx.planRepo);
    const s1 = await seedService(fx.pppoeRepo, { username: 's1@test' });

    const res = await asUser(
      request(fx.app).post('/api/pppoe/bulk/change-plan').send({ ids: [s1.id, 'no-existe'], profile: 'IP-50M' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toContain(s1.id);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe('no-existe');
    expect(res.body.failed[0].username).toBe('');
    expect(res.body.failed[0].error).toContain('PPPOE_NOT_FOUND');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// W1 fix-wave — un rechazo INESPERADO del use case (no un DomainError conocido) debe responder
// 500, NUNCA colgar la request (el bug era `throw err` dentro de un handler async de Express 4:
// una promesa rechazada sin catch nunca envía respuesta).
describe('POST /api/pppoe/bulk/change-plan — error inesperado del use case (W1)', () => {
  it('use case que rechaza con un Error genérico (no DomainError) → 500, la request NO cuelga', async () => {
    const fakeBulkUseCase = {
      execute: async () => {
        throw new Error('boom inesperado (simulado)');
      },
    } as unknown as BulkChangePppoePlan;

    const fx = await buildApp({ bulkUseCaseOverride: fakeBulkUseCase });
    await seedPlan(fx.planRepo);
    const s = await seedService(fx.pppoeRepo);

    const res = await asUser(
      request(fx.app).post('/api/pppoe/bulk/change-plan').send({ ids: [s.id], profile: 'IP-50M' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

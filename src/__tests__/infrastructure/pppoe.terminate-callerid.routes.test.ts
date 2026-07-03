/**
 * pppoe.terminate-callerid.routes.test.ts — seam tests para pppoe-terminate-callerid.
 *
 * Cubre:
 *   - DELETE /api/pppoe/:id { reason } → terminate (deleteUser RADIUS + status=terminated)
 *   - DELETE /api/pppoe/:id → funciona sin body (back-compat)
 *   - GET /api/pppoe/:id/caller-id → { callerId: 'AA:BB:CC:...' }
 *   - GET /api/pppoe/:id/caller-id → { callerId: null } si no hay sesión
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
import { GetPppoeCallerId } from '@application/use-cases/GetPppoeCallerId';
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
import type { OrchestratorSession } from '@domain/ports/RadiusOrchestratorGateway';
import { OrchestratorRejectedError, OrchestratorUnreachableError } from '@domain/errors/pppoe';

const NAS_RADIUS_ID = '3';  // radius_orchestrator (InMemoryNasRepository seed)
const CONTRACT_ID   = 'contract-term';

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
  orchestrator: InMemoryRadiusOrchestratorGateway;
  eventRepo: InMemoryContractServiceEventRepository;
  manageUserId: string;
}

async function buildApp(opts?: { sessionSeed?: OrchestratorSession[]; orchestrator?: InMemoryRadiusOrchestratorGateway }): Promise<Fixture> {
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

  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const routerGw    = new InMemoryRouterGateway();
  const nasRepo     = new InMemoryNasRepository();

  // Seed orchestrator with optional sessions
  const orchestratorSeed = opts?.sessionSeed
    ? [{ username: 'term-user', sessions: opts.sessionSeed }]
    : [];
  const orchestrator = opts?.orchestrator ?? new InMemoryRadiusOrchestratorGateway({ seed: orchestratorSeed });

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

  const terminatePppoe = new TerminatePppoeService(pppoeRepo, orchestrator, routerGw, nasRepo, ensure);
  const getCallerId    = new GetPppoeCallerId(pppoeRepo, orchestrator);

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
    terminatePppoe,
    getCallerId,
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, orchestrator, eventRepo, manageUserId: manageUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ════════════════════════════════════════════════════════════════════════════
// DELETE /api/pppoe/:id — now calls terminate (deleteUser + terminated status)
// ════════════════════════════════════════════════════════════════════════════

describe('DELETE /api/pppoe/:id — terminate (pppoe-terminate-callerid)', () => {
  it('204 + sets status=terminated + calls deleteUser', async () => {
    const fx = await buildApp();
    const row = await fx.pppoeRepo.upsertByUsername({
      username: 'term-user', password: 'pwd', nasId: NAS_RADIUS_ID, contractId: CONTRACT_ID,
      status: 'enabled', remoteAddress: '100.64.1.5',
    });

    const res = await asUser(
      request(fx.app).delete(`/api/pppoe/${row.id}`).send({ reason: 'baja definitiva' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(204);

    // Fila borrada — borrado HARD
    const updated = await fx.pppoeRepo.findById(row.id);
    expect(updated).toBeNull();

    const ops = fx.orchestrator.opsFor('term-user');
    expect(ops).toContain('deleteUser');
  });

  it('204 sin body (back-compat)', async () => {
    const fx = await buildApp();
    const row = await fx.pppoeRepo.upsertByUsername({
      username: 'term-user', password: 'pwd', nasId: NAS_RADIUS_ID, status: 'enabled',
    });

    const res = await asUser(
      request(fx.app).delete(`/api/pppoe/${row.id}`),
      fx.manageUserId,
    );

    expect(res.status).toBe(204);
    const updated = await fx.pppoeRepo.findById(row.id);
    expect(updated).toBeNull();
  });

  it('404 cuando el PPPoE no existe', async () => {
    const fx = await buildApp();

    const res = await asUser(
      request(fx.app).delete('/api/pppoe/does-not-exist'),
      fx.manageUserId,
    );

    expect(res.status).toBe(404);
  });

  // ── pppoe-update-504-handler: la baja HARD NO debe COLGAR cuando el orchestrator RECHAZA ──
  // deleteUser puede rechazar con 4xx (≠404) — p.ej. 409. Caía en `throw err` (Express 4) →
  // request colgada → proxy 504. Debe reenviar el upstreamStatus vía el errorHandler.
  it('orchestrator RECHAZA deleteUser (409) → 409 ORCHESTRATOR_REJECTED, la request NO cuelga', async () => {
    class RejectDeleteOrchestrator extends InMemoryRadiusOrchestratorGateway {
      override async deleteUser(): Promise<void> {
        throw new OrchestratorRejectedError(409, { detail: 'user has active sessions' });
      }
    }
    const fx = await buildApp({ orchestrator: new RejectDeleteOrchestrator() });
    const row = await fx.pppoeRepo.upsertByUsername({
      username: 'term-user', password: 'pwd', nasId: NAS_RADIUS_ID, contractId: CONTRACT_ID, status: 'enabled',
    });

    const res = await asUser(
      request(fx.app).delete(`/api/pppoe/${row.id}`).send({ reason: 'baja' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORCHESTRATOR_REJECTED');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/pppoe/:id/caller-id
// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/pppoe/:id/caller-id (pppoe-terminate-callerid)', () => {
  it('retorna { callerId } de la sesión activa', async () => {
    const session: OrchestratorSession = {
      sessionId: 'sess-abc',
      username: 'term-user',
      nasIp: '10.0.0.5',
      framedIp: '100.64.1.5',
      startedAt: new Date().toISOString(),
      bytesIn: 0,
      bytesOut: 0,
      callerId: 'AA:BB:CC:DD:EE:01',
    };
    const fx = await buildApp({ sessionSeed: [session] });
    const row = await fx.pppoeRepo.upsertByUsername({
      username: 'term-user', password: 'pwd', nasId: NAS_RADIUS_ID, status: 'enabled',
    });

    const res = await asUser(
      request(fx.app).get(`/api/pppoe/${row.id}/caller-id`),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ callerId: 'AA:BB:CC:DD:EE:01' });
  });

  it('retorna { callerId: null } si no hay sesión activa', async () => {
    const fx = await buildApp();
    const row = await fx.pppoeRepo.upsertByUsername({
      username: 'term-user', password: 'pwd', nasId: NAS_RADIUS_ID, status: 'enabled',
    });

    const res = await asUser(
      request(fx.app).get(`/api/pppoe/${row.id}/caller-id`),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ callerId: null });
  });

  it('404 cuando el PPPoE no existe', async () => {
    const fx = await buildApp();

    const res = await asUser(
      request(fx.app).get('/api/pppoe/no-such-id/caller-id'),
      fx.manageUserId,
    );

    expect(res.status).toBe(404);
  });

  // ── pppoe-update-504-handler: el caller-id NO debe COLGAR si el orchestrator está caído ──
  // listSessions puede tirar OrchestratorUnreachableError (red/timeout/5xx). El handler solo
  // mapeaba NotFound y terminaba en `throw err` → request colgada → proxy 504. Debe dar 502.
  it('orchestrator INALCANZABLE en listSessions → 502 ORCHESTRATOR_UNREACHABLE, la request NO cuelga', async () => {
    class UnreachableSessionsOrchestrator extends InMemoryRadiusOrchestratorGateway {
      override async listSessions(): Promise<never> {
        throw new OrchestratorUnreachableError('10.75.0.20:8080');
      }
    }
    const fx = await buildApp({ orchestrator: new UnreachableSessionsOrchestrator() });
    const row = await fx.pppoeRepo.upsertByUsername({
      username: 'term-user', password: 'pwd', nasId: NAS_RADIUS_ID, status: 'enabled',
    });

    const res = await asUser(
      request(fx.app).get(`/api/pppoe/${row.id}/caller-id`),
      fx.manageUserId,
    );

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ORCHESTRATOR_UNREACHABLE');
  });
});

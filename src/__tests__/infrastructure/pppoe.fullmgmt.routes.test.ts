/**
 * TDD — pppoe-full-management: route integration tests (Fases 1, 2, 3).
 *
 * Usa use cases REALES + repos in-memory (no mocks).
 * Seam de test: EchoAuthProvider bypasses JWT; requirePermission checks RBAC in-memory.
 *
 * Routes under test:
 *   GET  /api/pppoe?includeUnassigned=true  → incluye huérfanos (Fase 1)
 *   POST /api/pppoe                          → CreatePppoeStandalone (Fase 2)
 *   POST /api/pppoe/:id/rename              → RenamePppoeUsername (Fase 3)
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
import { CreatePppoeStandalone } from '@application/use-cases/CreatePppoeStandalone';
import { RenamePppoeUsername } from '@application/use-cases/RenamePppoeUsername';
import { OrchestratorEnforcementAdapter } from '@infrastructure/adapters/orchestrator/OrchestratorEnforcementAdapter';

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
  orchestrator: InMemoryRadiusOrchestratorGateway;
  readUserId: string;
  manageUserId: string;
  noPermUserId: string;
}

async function buildApp(opts?: { unreachableRouterIps?: string[] }): Promise<Fixture> {
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

  // Roles
  const readerRole  = await roleRepo.create({ code: 'pppoe_reader', label: 'PPPoE Reader', isSystem: false });
  const managerRole = await roleRepo.create({ code: 'pppoe_manager', label: 'PPPoE Manager', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'pppoe', action: 'read' });
  const managePerm  = await permRepo.seed({ moduleCode: 'pppoe', action: 'manage' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);

  const pwHash = await hasher.hash('pw');
  const readUser   = await userRepo.create({ name: 'reader',   email: 'r@x.com', login: 'r', passwordHash: pwHash, status: 'active' });
  const manageUser = await userRepo.create({ name: 'manager',  email: 'm@x.com', login: 'm', passwordHash: pwHash, status: 'active' });
  const noPermUser = await userRepo.create({ name: 'noperm',   email: 'n@x.com', login: 'n', passwordHash: pwHash, status: 'active' });
  await userRoleRepo.assign(readUser.id, readerRole.id);
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const routerGw    = new InMemoryRouterGateway({ unreachable: opts?.unreachableRouterIps });
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

  // CreatePppoeService también es el delegate de CreatePppoeStandalone (cuando viene contractId)
  const createPppoeServiceInstance = new CreatePppoeService(pppoeRepo, routerGw, nasRepo, orchestrator, ensure);
  // C2 fix: pasar router (para NAS mikrotik_api) y delegate (para path con contractId)
  const createPppoeStandalone = new CreatePppoeStandalone(pppoeRepo, orchestrator, nasRepo, routerGw, createPppoeServiceInstance);
  // fix-wave-2 (CRITICAL): nasRepo para el guard + radiusEnforcement (OrchestratorEnforcementAdapter directo, no PerNasGateway)
  const orchEnforcement = new OrchestratorEnforcementAdapter(orchestrator, 'IP-REDUCCION');
  const renamePppoeUsername  = new RenamePppoeUsername(pppoeRepo, orchestrator, nasRepo, orchEnforcement);

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
    new ListAllPppoeServices(pppoeRepo, eventRepo, catalogRepo, nasRepo),
    undefined,
    undefined,
    createPppoeStandalone,
    renamePppoeUsername,
  ));
  app.use(errorHandler);

  return {
    app,
    pppoeRepo,
    orchestrator,
    readUserId: readUser.id,
    manageUserId: manageUser.id,
    noPermUserId: noPermUser.id,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ════════════════════════════════════════════════════════════════════════════
// Fase 1 — GET /api/pppoe?includeUnassigned=true
// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/pppoe?includeUnassigned=true — incluir huérfanos (Fase 1)', () => {
  it('sin flag: huérfanos NO aparecen (pin comportamiento viejo)', async () => {
    const fx = await buildApp();
    await fx.pppoeRepo.upsertByUsername({ username: 'orphan', password: 'x', nasId: 'nas-1', contractId: null });
    await fx.pppoeRepo.upsertByUsername({ username: 'client', password: 'x', nasId: 'nas-1', contractId: 'ct-1' });

    const res = await asUser(request(fx.app).get('/api/pppoe'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].username).toBe('client');
  });

  it('includeUnassigned=true: huérfanos aparecen con clientId/customerName null', async () => {
    const fx = await buildApp();
    await fx.pppoeRepo.upsertByUsername({ username: 'orphan', password: 'x', nasId: 'nas-1', contractId: null });
    await fx.pppoeRepo.upsertByUsername({ username: 'client', password: 'x', nasId: 'nas-1', contractId: 'ct-1' });

    const res = await asUser(request(fx.app).get('/api/pppoe?includeUnassigned=true'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const orphanRow = res.body.data.find((d: {username: string}) => d.username === 'orphan');
    expect(orphanRow).toBeDefined();
    expect(orphanRow.clientId).toBeNull();
    expect(orphanRow.customerName).toBeNull();
    expect(orphanRow.contractId).toBeNull();
    // sin password
    expect(JSON.stringify(res.body)).not.toContain('"password"');
  });

  it('includeUnassigned=false: equivalente a sin flag', async () => {
    const fx = await buildApp();
    await fx.pppoeRepo.upsertByUsername({ username: 'orphan', password: 'x', nasId: 'nas-1', contractId: null });

    const res = await asUser(request(fx.app).get('/api/pppoe?includeUnassigned=false'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('nasId combinado con includeUnassigned=true', async () => {
    const fx = await buildApp();
    await fx.pppoeRepo.upsertByUsername({ username: 'o1', password: 'x', nasId: '1', contractId: null });
    await fx.pppoeRepo.upsertByUsername({ username: 'o2', password: 'x', nasId: '2', contractId: null });

    const res = await asUser(request(fx.app).get('/api/pppoe?includeUnassigned=true&nasId=1'), fx.readUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].username).toBe('o1');
  });

  it('DTO incluye remoteAddress e ipMode', async () => {
    const fx = await buildApp();
    await fx.pppoeRepo.upsertByUsername({
      username: 'c1',
      password: 'x',
      nasId: 'nas-1',
      contractId: 'ct-1',
      remoteAddress: '10.0.0.1',
      ipMode: 'fixed',
    });

    const res = await asUser(request(fx.app).get('/api/pppoe'), fx.readUserId);
    expect(res.status).toBe(200);
    const item = res.body.data[0];
    expect(item.remoteAddress).toBe('10.0.0.1');
    expect(item.ipMode).toBe('fixed');
  });

  it('gate: 403 sin pppoe.read', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe?includeUnassigned=true'), fx.noPermUserId);
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fase 2 — POST /api/pppoe (CreatePppoeStandalone)
// ════════════════════════════════════════════════════════════════════════════

describe('POST /api/pppoe — CreatePppoeStandalone (Fase 2)', () => {
  it('201 con cuerpo válido sin contrato → DTO sin password, contractId null', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe').send({
        username: 'newuser',
        password: 'pass123',
        plan: 'IP-10-5',
        nasId: '1',
        // pppoe-preprovision: ipTypePreference ahora es REQUERIDO en el wire — 'cgnat' explicito.
        ipTypePreference: 'cgnat',
      }),
      fx.manageUserId,
    );

    expect(res.status).toBe(201);
    expect(res.body.username).toBe('newuser');
    expect(res.body.contractId).toBeNull();
    expect(res.body.password).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('pass123');
    expect(res.body.id).toBeTruthy();
    expect(res.body.nasId).toBe('1');
  });

  it('201 con contractId → DTO con contractId', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe').send({
        username: 'withcontract',
        password: 'pass',
        plan: 'IP-20-10',
        nasId: '1',
        contractId: 'ct-xyz',
        ipTypePreference: 'cgnat', // pppoe-preprovision: requerido en el wire
      }),
      fx.manageUserId,
    );

    expect(res.status).toBe(201);
    expect(res.body.contractId).toBe('ct-xyz');
  });

  it('409 username duplicado', async () => {
    const fx = await buildApp();
    // Primero crear el usuario
    await fx.pppoeRepo.upsertByUsername({ username: 'dupe', password: 'x', nasId: 'n', contractId: null });

    const res = await asUser(
      request(fx.app).post('/api/pppoe').send({ username: 'dupe', password: 'new', plan: 'P', nasId: '1', ipTypePreference: 'cgnat' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_USERNAME_TAKEN');
  });

  it('422 body inválido (falta username)', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe').send({ password: 'p', plan: 'P', nasId: '1' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
  });

  it('502 cuando el router MikroTik no responde (RouterUnreachableError → 502)', async () => {
    // NAS '1' (mikrotik_api) tiene ipAddress '192.168.1.1'.
    // Al marcarlo como unreachable, router.createSecret lanza RouterUnreachableError.
    const fx = await buildApp({ unreachableRouterIps: ['192.168.1.1'] });

    const res = await asUser(
      request(fx.app).post('/api/pppoe').send({
        username: 'routerdown',
        password: 'pass',
        plan: 'IP-10-5',
        nasId: '1', // mikrotik_api → usa router.createSecret (no orchestrator)
        ipTypePreference: 'cgnat', // pppoe-preprovision: requerido en el wire
      }),
      fx.manageUserId,
    );

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ROUTER_UNREACHABLE');
  });

  it('403 sin pppoe.manage (reader no puede crear)', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe').send({ username: 'x', password: 'p', plan: 'P', nasId: '1' }),
      fx.readUserId,
    );
    expect(res.status).toBe(403);
  });

  it('401 sin autenticación', async () => {
    const fx = await buildApp();
    const res = await request(fx.app).post('/api/pppoe').send({ username: 'x', password: 'p', plan: 'P', nasId: '1' });
    expect(res.status).toBe(401);
  });

  // ── W2: contractId ya tiene PPPoE → 409 (no 400) ────────────────────────
  it('W2 — POST /pppoe con contractId que ya tiene PPPoE enabled → 409 PPPOE_CONTRACT_ALREADY_HAS_SERVICE', async () => {
    const fx = await buildApp();

    // Sembrar un PPPoE enabled para el contrato 'ct-taken-w2'
    await fx.pppoeRepo.upsertByUsername({
      username:   'existing-for-ct',
      password:   'p',
      profile:    'P1',
      nasId:      '3',  // radius_orchestrator (NAS_RADIUS)
      contractId: 'ct-taken-w2',
      status:     'enabled',
    });

    // Intentar crear un SEGUNDO PPPoE para el mismo contrato vía standalone
    const res = await asUser(
      request(fx.app).post('/api/pppoe').send({
        username:   'second-svc-w2',
        password:   'pass',
        plan:       'IP-10-5',
        nasId:      '3',
        contractId: 'ct-taken-w2',
        ipTypePreference: 'cgnat', // pppoe-preprovision: requerido en el wire
      }),
      fx.manageUserId,
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_CONTRACT_ALREADY_HAS_SERVICE');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fase 3 — POST /api/pppoe/:id/rename (RenamePppoeUsername)
// ════════════════════════════════════════════════════════════════════════════

describe('POST /api/pppoe/:id/rename — RenamePppoeUsername (Fase 3)', () => {
  it('200 happy path: { id, username: newUsername, status: ok }', async () => {
    const fx = await buildApp();
    // Sembrar en espejo y orchestrator (nasId '3' = radius_orchestrator — requerido por el guard)
    const svc = await fx.pppoeRepo.upsertByUsername({
      username: 'oldname',
      password: 'pass',
      profile: 'P1',
      nasId: '3',
      contractId: null,
    });
    await fx.orchestrator.createUser({ username: 'oldname', password: 'pass', plan: 'P1' });

    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${svc.id}/rename`).send({ newUsername: 'newname' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.username).toBe('newname');
    expect(res.body.id).toBe(svc.id);
  });

  it('409 cuando el nuevo username ya existe', async () => {
    const fx = await buildApp();
    // nasId '3' = radius_orchestrator — requerido por el guard del rename
    const svc = await fx.pppoeRepo.upsertByUsername({ username: 'oldname2', password: 'p', profile: 'P', nasId: '3', contractId: null });
    await fx.pppoeRepo.upsertByUsername({ username: 'taken', password: 'p', profile: 'P', nasId: '3', contractId: null });
    await fx.orchestrator.createUser({ username: 'oldname2', password: 'p', plan: 'P' });

    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${svc.id}/rename`).send({ newUsername: 'taken' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_USERNAME_TAKEN');
  });

  it('404 cuando el PPPoE no existe', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe/nonexistent-id/rename').send({ newUsername: 'whatever' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
  });

  it('422 body inválido (falta newUsername)', async () => {
    const fx = await buildApp();
    const svc = await fx.pppoeRepo.upsertByUsername({ username: 'old', password: 'p', profile: 'P', nasId: '3', contractId: null });

    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${svc.id}/rename`).send({}),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
  });

  it('403 sin pppoe.manage', async () => {
    const fx = await buildApp();
    const svc = await fx.pppoeRepo.upsertByUsername({ username: 'old3', password: 'p', profile: 'P', nasId: '3', contractId: null });

    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${svc.id}/rename`).send({ newUsername: 'new3' }),
      fx.readUserId,
    );
    expect(res.status).toBe(403);
  });

  it('422 cuando el PPPoE no tiene profile — PppoeProfileRequiredError (CRITICAL-1)', async () => {
    // Seed con nasId '3' (radius_orchestrator) y sin profile → RenamePppoeUsername lanza
    // PppoeProfileRequiredError. Sin el fix en el catch, la request queda colgada (hang).
    const fx = await buildApp();
    const svc = await fx.pppoeRepo.upsertByUsername({
      username: 'no-profile-user',
      password: 'pass',
      // profile omitido → null → PppoeProfileRequiredError
      nasId: '3',
      contractId: null,
    });

    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${svc.id}/rename`).send({ newUsername: 'nuevo-nombre' }),
      fx.manageUserId,
    );

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PPPOE_PROFILE_REQUIRED');
  });

  it('/rename no es sombreada por /:id (orden de montaje correcto)', async () => {
    // Verificar que POST /api/pppoe/:id/rename no queda atrapada por el PATCH /api/pppoe/:id
    // Al ser un POST distinto (rename) y con body {newUsername}, el router lo debe rutear correctamente.
    const fx = await buildApp();
    // nasId '3' = radius_orchestrator — requerido por el guard del rename
    const svc = await fx.pppoeRepo.upsertByUsername({ username: 'shadowtest', password: 'p', profile: 'P', nasId: '3', contractId: null });
    await fx.orchestrator.createUser({ username: 'shadowtest', password: 'p', plan: 'P' });

    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${svc.id}/rename`).send({ newUsername: 'shadowtest-new' }),
      fx.manageUserId,
    );
    // Si hubiera shadowing devolvería algo diferente. Esperamos que el rename funcione.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// sqlippool-cleanup (REQ-DEL-1) — las rutas pin-ip/unpin-ip fueron REMOVIDAS
// ════════════════════════════════════════════════════════════════════════════

describe('sqlippool-cleanup — rutas pin/unpin eliminadas (REQ-DEL-1)', () => {
  it('S1.1: POST /api/pppoe/:id/pin-ip → 404 (ruta inexistente, no 401/403/otro handler)', async () => {
    const fx = await buildApp();
    const res = await request(fx.app).post('/api/pppoe/whatever/pin-ip').send({ ip: '100.64.10.10' });
    expect(res.status).toBe(404);
  });

  it('POST /api/pppoe/:id/unpin-ip → 404 (ruta inexistente)', async () => {
    const fx = await buildApp();
    const res = await request(fx.app).post('/api/pppoe/whatever/unpin-ip').send({});
    expect(res.status).toBe(404);
  });
});

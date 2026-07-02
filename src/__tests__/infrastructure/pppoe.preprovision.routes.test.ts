/**
 * pppoe.preprovision.routes.test.ts — supertest para pppoe-preprovision-autoinstall
 * (tasks 1.2/1.3, wire contract del change — el FE se construye EN PARALELO contra esto).
 *
 *   POST /api/contracts/:contractId/pppoe
 *     - body += ipTypePreference ('cgnat'|'public') REQUERIDO → 422 VALIDATION_ERROR si falta/inválido (S1.2)
 *     - nasId OPCIONAL: ausente/null = pre-provisión → 201 con nasId null (S1.1)
 *   POST /api/pppoe (standalone): mismo contrato de body.
 *   PppoeServiceDto += ipTypePreference; nasId: string|null.
 *   GET /api/pppoe: pendientes listados con nas null sin crash (S4.1).
 *   POST /api/pppoe/:id/enforce de un pendiente → 409 PPPOE_PENDING_INSTALL (S4.2).
 *   POST /api/pppoe/:id/move de un pendiente → adopción manual con el tipo persistido (S4.3).
 *   PATCH de un pendiente → 409 tipado (no cuelga, no 500).
 *   DELETE de un pendiente (terminate wired) → 204 + user borrado del RADIUS.
 *
 * Harness espejo de pppoe.move-nas.routes.test.ts (EchoAuthProvider + RBAC in-memory + errorHandler).
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
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryPppoeNasMoveEventRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeNasMoveEventRepository';
import { InMemoryServiceCutBatchRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCutBatchRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { CreatePppoeStandalone } from '@application/use-cases/CreatePppoeStandalone';
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { MovePppoeToNas } from '@application/use-cases/MovePppoeToNas';
import { ListPppoeNasMoveEvents } from '@application/use-cases/ListPppoeNasMoveEvents';
import { ListAllPppoeServices } from '@application/use-cases/ListAllPppoeServices';
import { ListAllPppoeServiceIds } from '@application/use-cases/ListAllPppoeServiceIds';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
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

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { NasServer } from '@domain/entities/nas';
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
    return { id: token, username: 'operador', email: 'test@test.com', role: 'admin' };
  }
}

const CONTRACT_ID = 'contract-1';

interface Fixture {
  app: express.Express;
  pppoeRepo: InMemoryPppoeServiceRepository;
  orchestrator: InMemoryRadiusOrchestratorGateway;
  moveEvents: InMemoryPppoeNasMoveEventRepository;
  nasB: NasServer;
  manageUserId: string;
  cutUserId: string;
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

  const managerRole = await roleRepo.create({ code: 'pppoe_manager', label: 'PPPoE Manager', isSystem: false });
  const cutterRole  = await roleRepo.create({ code: 'pppoe_cutter', label: 'PPPoE Cutter', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'pppoe', action: 'read' });
  const managePerm  = await permRepo.seed({ moduleCode: 'pppoe', action: 'manage' });
  const cutPerm     = await permRepo.seed({ moduleCode: 'pppoe', action: 'cut' });
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(cutterRole.id, cutPerm.id);

  const pwHash = await hasher.hash('pw');
  const manageUser = await userRepo.create({ name: 'manager', email: 'm@x.com', login: 'manager', passwordHash: pwHash, status: 'active' });
  const cutUser    = await userRepo.create({ name: 'cutter', email: 'c@x.com', login: 'cutter', passwordHash: pwHash, status: 'active' });
  await userRoleRepo.assign(manageUser.id, managerRole.id);
  await userRoleRepo.assign(cutUser.id, cutterRole.id);

  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const routerGw  = new InMemoryRouterGateway();
  const nasRepo   = new InMemoryNasRepository();
  const netRepo   = new InMemoryIpNetworkRepository();
  const moveEvents = new InMemoryPppoeNasMoveEventRepository();
  const csRepo    = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  await catalogRepo.create({ name: 'INTERNET' });
  const eventRepo = new InMemoryContractServiceEventRepository();
  const ensure    = new EnsureInternetContractService(csRepo, catalogRepo);
  const orchestrator = new InMemoryRadiusOrchestratorGateway({
    assignedIps: ['100.64.43.2', '190.15.242.2'],
  });

  // NAS destino radius B con pool cgnat + pool public (adopción con tipo persistido).
  const nasB = await nasRepo.createNasServer({
    name: 'NAS Radius B', type: 'radius_orchestrator', ipAddress: '10.0.0.6',
    radiusSecret: 'x', nasIpAddress: '10.0.0.6', apiPort: null, apiLogin: null,
    apiPassword: null, status: 'active', lastSeen: null, clientCount: 0, description: '',
  });
  netRepo.seedNetwork({
    id: 'net-b', network: '100.64.43.0/24', gateway: '100.64.43.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'CGNAT B', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-b-cg', name: 'cgnat-b', networkId: 'net-b',
    rangeStart: '100.64.43.2', rangeEnd: '100.64.43.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: nasB.id, ipKind: 'cgnat',
  });
  netRepo.seedNetwork({
    id: 'net-pub', network: '190.15.242.0/24', gateway: '190.15.242.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'Públicas B', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-b-pub', name: 'publicas-b', networkId: 'net-pub',
    rangeStart: '190.15.242.2', rangeEnd: '190.15.242.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: nasB.id, ipKind: 'public',
  });

  const findFreeIp = new FindFreeIp(netRepo, nasRepo, routerGw, orchestrator);
  const legacyMove = new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo);
  const movePppoeToNas = new MovePppoeToNas(
    pppoeRepo, nasRepo, orchestrator, findFreeIp, legacyMove, moveEvents, catalogRepo, eventRepo, netRepo,
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
  const createPppoeSvc = new CreatePppoeService(
    pppoeRepo, routerGw, nasRepo, orchestrator, ensure, undefined, undefined, findFreeIp,
  );

  app.use('/api', createPppoeRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    new ListPppoeByContract(pppoeRepo),
    createPppoeSvc,
    new UpdatePppoeService(pppoeRepo, routerGw, nasRepo, orchestrator),
    legacyMove,
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
    new TerminatePppoeService(pppoeRepo, orchestrator, routerGw, nasRepo, ensure),
    undefined, // getPppoeCallerId
    new ListAllPppoeServices(pppoeRepo, eventRepo, catalogRepo, nasRepo),
    undefined, // listInternetServiceHistory
    undefined, // listInternetActivationOperators
    undefined, // pinPppoeIp
    undefined, // unpinPppoeIp
    new CreatePppoeStandalone(pppoeRepo, orchestrator, nasRepo, routerGw, createPppoeSvc, findFreeIp),
    undefined, // renamePppoeUsername
    movePppoeToNas,
    new ListPppoeNasMoveEvents(moveEvents, nasRepo),
    undefined, // bulkChangePppoePlan
    // D6.7: GET /pppoe/ids con pending=true (chip Pendientes server-side, paridad list↔ids).
    new ListAllPppoeServiceIds(pppoeRepo),
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, orchestrator, moveEvents, nasB, manageUserId: manageUser.id, cutUserId: cutUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedPending(fx: Fixture, ipTypePreference: 'cgnat' | 'public', opts?: { contractId?: string | null }) {
  return fx.pppoeRepo.upsertByUsername({
    username: 'pendiente',
    password: 'secret',
    profile: 'IP-Air-10M',
    remoteAddress: null,
    status: 'enabled',
    nasId: null,
    contractId: opts?.contractId ?? null,
    ipMode: 'fixed',
    ipTypePreference,
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// Wire contract — ipTypePreference REQUERIDO en TODA creación (S1.2 / S1.4)
// ════════════════════════════════════════════════════════════════════════════════

describe('POST /api/contracts/:contractId/pppoe — ipTypePreference requerido + nasId opcional', () => {
  it('S1.2: sin ipTypePreference → 422 VALIDATION_ERROR y NADA creado', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({ username: 'u1', password: 'p', profile: 'P1' }), // sin nasId Y sin ipTypePreference
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await fx.pppoeRepo.findByUsername('u1')).toBeNull();
    expect(fx.orchestrator.createdUser('u1')).toBeUndefined();
  });

  it("ipTypePreference inválido ('banana') → 422 VALIDATION_ERROR", async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({ username: 'u1', password: 'p', profile: 'P1', nasId: '3', ipTypePreference: 'banana' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('S1.1: sin nasId (pre-provisión) → 201; DTO {nasId:null, remoteAddress:null, ipTypePreference}; RADIUS sin Framed-IP', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({ username: 'preprov', password: 'secret', profile: 'IP-Air-30-10', ipTypePreference: 'public' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.nasId).toBeNull();
    expect(res.body.remoteAddress).toBeNull();
    expect(res.body.ipTypePreference).toBe('public');
    expect(res.body.status).toBe('enabled');
    expect(res.body.ipMode).toBe('fixed');
    expect(res.body.password).toBeUndefined();
    expect(fx.orchestrator.createdUser('preprov')!.framedIp).toBeNull();
  });

  it('S1.3 (wire): sin nasId y sin profile → 422 PPPOE_PROFILE_REQUIRED, nada creado', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({ username: 'sinplan', password: 'p', ipTypePreference: 'cgnat' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PPPOE_PROFILE_REQUIRED');
    expect(await fx.pppoeRepo.findByUsername('sinplan')).toBeNull();
  });

  it('S1.4 regresión: flujo CON NAS + remoteAddress explícita intacto (201, DTO con ipTypePreference)', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({
          username: 'connas', password: 'p', profile: 'IP-Air-30-10', nasId: '3',
          remoteAddress: '100.64.10.10', ipTypePreference: 'cgnat',
        }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.nasId).toBe('3');
    expect(res.body.remoteAddress).toBe('100.64.10.10');
    expect(res.body.ipTypePreference).toBe('cgnat');
  });
});

describe('POST /api/pppoe (standalone) — mismo wire contract', () => {
  it('sin ipTypePreference → 422 VALIDATION_ERROR', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe').send({ username: 'u2', password: 'p', plan: 'P1', nasId: '3' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('sin nasId → 201 con nasId null (huérfano pendiente de instalación)', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe')
        .send({ username: 'preprov-sa', password: 'p', plan: 'IP-10-5', ipTypePreference: 'cgnat' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.nasId).toBeNull();
    expect(res.body.remoteAddress).toBeNull();
    expect(res.body.ipTypePreference).toBe('cgnat');
    expect(res.body.contractId).toBeNull();
    expect(fx.orchestrator.createdUser('preprov-sa')!.framedIp).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Barrido nasId-null en el wire (S4.1 / S4.2 / S4.3)
// ════════════════════════════════════════════════════════════════════════════════

describe('S4.1 — GET /api/pppoe lista pendientes con nas null sin crash', () => {
  it('pendiente asociado a contrato → 200, item {nasId:null, nasName:null, ipTypePreference}', async () => {
    const fx = await buildApp();
    await seedPending(fx, 'public', { contractId: 'ct-1' });

    const res = await asUser(request(fx.app).get('/api/pppoe'), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    const item = res.body.data[0];
    expect(item.username).toBe('pendiente');
    expect(item.nasId).toBeNull();
    expect(item.nasName).toBeNull();
    expect(item.nasType).toBeNull();
    expect(item.ipTypePreference).toBe('public');
    expect(item.status).toBe('active'); // displayStatus: enabled+active (sin status nuevo)
  });
});

describe('S4.2 — enforce de un pendiente → 409 PPPOE_PENDING_INSTALL', () => {
  it('POST /pppoe/:id/enforce → 409 tipado, sin crash ni cuelgue', async () => {
    const fx = await buildApp();
    const s = await seedPending(fx, 'cgnat');

    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/enforce`).send({ action: 'reduce' }),
      fx.cutUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_PENDING_INSTALL');
  });

  it('PATCH /pppoe/:id de un pendiente → 409 PPPOE_PENDING_INSTALL (no 500, no cuelgue)', async () => {
    const fx = await buildApp();
    const s = await seedPending(fx, 'cgnat');

    const res = await asUser(
      request(fx.app).patch(`/api/pppoe/${s.id}`).send({ password: 'nueva' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_PENDING_INSTALL');
  });
});

describe('S4.3 — move manual de un pendiente = adopción manual', () => {
  it("pendiente 'public' movido a NAS B → 200; IP del pool PÚBLICO (tipo persistido), evento con fromNas null", async () => {
    const fx = await buildApp();
    const s = await seedPending(fx, 'public');

    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasB.id }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.nasId).toBe(fx.nasB.id);
    expect(res.body.remoteAddress).toBe('190.15.242.3'); // pool public: .2 tomada → primera libre
    expect(res.body.ipMode).toBe('fixed');

    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      username: 'pendiente',
      fromNasId: null,
      toNasId: fx.nasB.id,
      outcome: 'moved',
      trigger: 'manual',
    });
  });

  it("pendiente 'cgnat' movido a NAS B → 200 con IP del pool cgnat, SIN force", async () => {
    const fx = await buildApp();
    const s = await seedPending(fx, 'cgnat');

    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasB.id }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.remoteAddress).toBe('100.64.43.3');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// D6 — Endurecimiento post-review (fix wave): guards de input y de adopción en el wire
// ════════════════════════════════════════════════════════════════════════════════

describe('D6.6 — remoteAddress/framedIp SIN nasId → 422 (el input incoherente no se descarta en silencio)', () => {
  it('POST /contracts/:id/pppoe con remoteAddress y SIN nasId → 422 VALIDATION_ERROR, nada creado', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({
          username: 'incoherente', password: 'p', profile: 'IP-Air-10M',
          ipTypePreference: 'cgnat', remoteAddress: '100.64.43.10', // IP pedida… ¿en qué NAS?
        }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await fx.pppoeRepo.findByUsername('incoherente')).toBeNull();
    expect(fx.orchestrator.createdUser('incoherente')).toBeUndefined();
  });

  it('POST /pppoe (standalone) con framedIp y SIN nasId → 422 VALIDATION_ERROR, nada creado', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe')
        .send({
          username: 'incoherente-sa', password: 'p', plan: 'IP-10-5',
          ipTypePreference: 'cgnat', framedIp: '100.64.43.10',
        }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await fx.pppoeRepo.findByUsername('incoherente-sa')).toBeNull();
    expect(fx.orchestrator.createdUser('incoherente-sa')).toBeUndefined();
  });

  it('control: remoteAddress null EXPLÍCITO sin nasId sigue siendo una pre-provisión válida (201)', async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({
          username: 'coherente', password: 'p', profile: 'IP-Air-10M',
          ipTypePreference: 'cgnat', remoteAddress: null,
        }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.nasId).toBeNull();
  });
});

describe("D6.8 — ipTypePreference 'public' + NAS en modo POOL → 422 tipado (el sqlippool asignaría cgnat: el alta mentiría)", () => {
  // El NAS '3' del seed del InMemoryNasRepository es radius_orchestrator con poolName 'asur-cgnat'.
  it("POST /contracts/:id/pppoe {nasId:'3', 'public', sin IP} → 422 PPPOE_PUBLIC_IP_POOL_MODE, nada creado", async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({
          username: 'pubpool', password: 'p', profile: 'IP-PUB-50',
          nasId: '3', ipTypePreference: 'public',
        }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PPPOE_PUBLIC_IP_POOL_MODE');
    expect(await fx.pppoeRepo.findByUsername('pubpool')).toBeNull();
    expect(fx.orchestrator.createdUser('pubpool')).toBeUndefined();
  });

  it("POST /pppoe (standalone) {nasId:'3', 'public', sin framedIp} → 422 PPPOE_PUBLIC_IP_POOL_MODE, nada creado", async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post('/api/pppoe')
        .send({ username: 'pubpool-sa', password: 'p', plan: 'IP-PUB-50', nasId: '3', ipTypePreference: 'public' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PPPOE_PUBLIC_IP_POOL_MODE');
    expect(await fx.pppoeRepo.findByUsername('pubpool-sa')).toBeNull();
    expect(fx.orchestrator.createdUser('pubpool-sa')).toBeUndefined();
  });

  it("regresión: {nasId:'3', 'cgnat', sin IP} sigue siendo un alta pool-mode válida (201, ipMode 'pool')", async () => {
    const fx = await buildApp();
    const res = await asUser(
      request(fx.app).post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({ username: 'cgpool', password: 'p', profile: 'IP-Air-10M', nasId: '3', ipTypePreference: 'cgnat' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.ipMode).toBe('pool');
    expect(res.body.remoteAddress).toBeNull();
  });
});

describe("D6.7 — filtro 'pending=true' server-side en GET /pppoe y GET /pppoe/ids (paridad por construcción)", () => {
  /** Seed: 1 pendiente (nasId null) + 1 instalado (nasId '3'), ambos CON contrato. */
  async function seedMixed(fx: Fixture) {
    const pending = await seedPending(fx, 'cgnat', { contractId: 'ct-pend' });
    const installed = await fx.pppoeRepo.upsertByUsername({
      username: 'instalado', password: 'x', profile: 'IP-Air-10M', remoteAddress: '100.64.43.50',
      status: 'enabled', nasId: '3', contractId: 'ct-inst', ipMode: 'fixed', ipTypePreference: 'cgnat',
    });
    return { pending, installed };
  }

  it('GET /pppoe?pending=true → SOLO pendientes (nasId null), con paginación server-side correcta', async () => {
    const fx = await buildApp();
    const { pending } = await seedMixed(fx);

    const res = await asUser(request(fx.app).get('/api/pppoe?pending=true'), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(pending.id);
    expect(res.body.data[0].nasId).toBeNull();
  });

  it('GET /pppoe SIN pending → ambos (regresión: el filtro es opt-in)', async () => {
    const fx = await buildApp();
    await seedMixed(fx);

    const res = await asUser(request(fx.app).get('/api/pppoe'), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('GET /pppoe/ids?pending=true → 200 (pending CUENTA como filtro de narrowing) con SOLO los ids pendientes', async () => {
    const fx = await buildApp();
    const { pending } = await seedMixed(fx);

    const res = await asUser(request(fx.app).get('/api/pppoe/ids?pending=true'), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.ids).toEqual([pending.id]);
    expect(res.body.total).toBe(1);
  });

  it('GET /pppoe/ids sin NINGÚN filtro → 400 FILTER_REQUIRED (regresión: pending no relaja el guard cuando no viene)', async () => {
    const fx = await buildApp();
    await seedMixed(fx);

    const res = await asUser(request(fx.app).get('/api/pppoe/ids'), fx.manageUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILTER_REQUIRED');
  });

  it('paridad list↔ids: mismo filtro pending=true → el ids devuelve EXACTAMENTE lo que lista el GET /pppoe', async () => {
    const fx = await buildApp();
    await seedMixed(fx);
    // Un segundo pendiente con contrato para que la paridad no sea trivial de a 1.
    await fx.pppoeRepo.upsertByUsername({
      username: 'pendiente2', password: 'x', profile: 'IP-Air-10M', remoteAddress: null,
      status: 'enabled', nasId: null, contractId: 'ct-pend-2', ipMode: 'fixed', ipTypePreference: 'public',
    });

    const list = await asUser(request(fx.app).get('/api/pppoe?pending=true&limit=100'), fx.manageUserId);
    const ids  = await asUser(request(fx.app).get('/api/pppoe/ids?pending=true'), fx.manageUserId);

    expect(list.status).toBe(200);
    expect(ids.status).toBe(200);
    const listedIds = (list.body.data as { id: string }[]).map(d => d.id).sort();
    expect([...(ids.body.ids as string[])].sort()).toEqual(listedIds);
    expect(ids.body.total).toBe(list.body.total);
  });
});

describe('D6.5 (wire) — move de un pendiente hacia un NAS LEGACY → 409 PPPOE_PENDING_LEGACY_NAS', () => {
  it("POST /pppoe/:id/move {nasId:'1' (mikrotik_api)} de un pendiente → 409 tipado via errorHandler", async () => {
    const fx = await buildApp();
    const s = await seedPending(fx, 'cgnat');

    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: '1' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_PENDING_LEGACY_NAS');

    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBeNull();
    expect(fx.moveEvents.all()).toHaveLength(0);
  });
});

describe('DELETE /api/pppoe/:id de un pendiente — limpieza (terminate radius-central)', () => {
  it('204: borra el user del RADIUS central y la fila (sin NAS no hay router que tocar)', async () => {
    const fx = await buildApp();
    const s = await seedPending(fx, 'cgnat');
    await fx.orchestrator.createUser({ username: 'pendiente', password: 'secret', plan: 'IP-Air-10M' });

    const res = await asUser(request(fx.app).delete(`/api/pppoe/${s.id}`), fx.manageUserId);
    expect(res.status).toBe(204);
    expect(fx.orchestrator.calls.some(c => c.op === 'deleteUser' && c.username === 'pendiente')).toBe(true);
    expect(await fx.pppoeRepo.findById(s.id)).toBeNull();
  });
});

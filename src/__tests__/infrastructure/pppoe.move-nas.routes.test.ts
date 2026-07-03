/**
 * pppoe.move-nas.routes.test.ts — supertest para pppoe-move-nas W1:
 *   POST /api/pppoe/:id/move            (gate pppoe.manage — cableado al NUEVO MovePppoeToNas)
 *   GET  /api/pppoe/nas-move-events     (gate network.read — registro visible en la page de auditoria, wire contract D6)
 *
 * Foco: mapeo error→HTTP del move radius-aware + wire contract del listado campo por campo.
 *   move:   200 (IP nueva en el DTO) · 404 service/nas · 409 NO_FREE_IP · 409 mixto
 *           · 502 ORCHESTRATOR_UNREACHABLE · 422 body inválido · 401/403 gates
 *   events: 200 {items,total,page,limit} · filtros outcome/trigger/username · paginado
 *           · limit clamp 100 · 401/403 gates
 *
 * Patrón espejo de pppoe.pin-ip.routes.test.ts (EchoAuthProvider + cookie token = userId + RBAC in-memory).
 * NAS seed (InMemoryNasRepository): '1' mikrotik_api (legacy) · '3' radius_orchestrator. El destino
 * radius B se crea en el fixture con su pool cgnat 100.64.43.0/24 (100.64.43.2 tomada → primera libre .3).
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
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { MovePppoeToNas } from '@application/use-cases/MovePppoeToNas';
import { ListPppoeNasMoveEvents } from '@application/use-cases/ListPppoeNasMoveEvents';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
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
import type { NasServer } from '@domain/entities/nas';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { OrchestratorRejectedError } from '@domain/errors/pppoe';

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

const RADIUS_NAS_A = '3'; // radius_orchestrator (seed InMemoryNasRepository)
const MK_NAS       = '1'; // mikrotik_api (legacy)
const OLD_IP       = '100.64.60.25';

interface Fixture {
  app: express.Express;
  pppoeRepo: InMemoryPppoeServiceRepository;
  moveEvents: InMemoryPppoeNasMoveEventRepository;
  nasRadiusB: NasServer;
  /** fix wave 1: NAS radius SIN pools cgnat (para el mapeo NO_POOL_FOR_NAS_TYPE → 404). */
  nasRadiusC: NasServer;
  readUserId: string;
  manageUserId: string;
  nobodyUserId: string;
  /** review FE W1: el listado de movimientos gatea network.read (tabs vecinos de la page de auditoría). */
  networkUserId: string;
}

async function buildApp(opts?: {
  assignedIps?: string[];
  unreachableUsers?: string[];
  poolRange?: { start: string; end: string };
  /** fix wave 1: orchestrator custom (p.ej. que rechaza changeFramedIp con 409 — S1.6). */
  orchestrator?: InMemoryRadiusOrchestratorGateway;
}): Promise<Fixture> {
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

  const readerRole  = await roleRepo.create({ code: 'pppoe_reader', label: 'PPPoE Reader', isSystem: false });
  const managerRole = await roleRepo.create({ code: 'pppoe_manager', label: 'PPPoE Manager', isSystem: false });
  const networkRole = await roleRepo.create({ code: 'network_reader', label: 'Network Reader', isSystem: false });
  const readPerm    = await permRepo.seed({ moduleCode: 'pppoe', action: 'read' });
  const managePerm  = await permRepo.seed({ moduleCode: 'pppoe', action: 'manage' });
  const networkPerm = await permRepo.seed({ moduleCode: 'network', action: 'read' });
  await rolePermRepo.grant(readerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(networkRole.id, networkPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const readUser   = await mkUser('reader');
  const manageUser = await mkUser('manager');
  const nobodyUser = await mkUser('nobody'); // sin roles → 403 en todo
  const networkUser = await mkUser('networker'); // network.read SOLO (perfil NOC de la page de auditoría)
  await userRoleRepo.assign(readUser.id, readerRole.id);
  await userRoleRepo.assign(manageUser.id, managerRole.id);
  await userRoleRepo.assign(networkUser.id, networkRole.id);

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
  const orchestrator = opts?.orchestrator ?? new InMemoryRadiusOrchestratorGateway({
    assignedIps: opts?.assignedIps ?? ['100.64.43.2', OLD_IP],
    unreachable: opts?.unreachableUsers,
  });

  // NAS destino radius B + su pool cgnat 100.64.43.0/24.
  const nasRadiusB = await nasRepo.createNasServer({
    name: 'NAS Radius B',
    type: 'radius_orchestrator',
    ipAddress: '10.0.0.6',
    radiusSecret: 'x',
    nasIpAddress: '10.0.0.6',
    apiPort: null,
    apiLogin: null,
    apiPassword: null,
    status: 'active',
    lastSeen: null,
    clientCount: 0,
    description: 'destino radius',
  });
  netRepo.seedNetwork({
    id: 'net-b', network: '100.64.43.0/24', gateway: '100.64.43.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'CGNAT NAS B', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-b', name: 'cgnat-nas-b', networkId: 'net-b',
    rangeStart: opts?.poolRange?.start ?? '100.64.43.2',
    rangeEnd:   opts?.poolRange?.end   ?? '100.64.43.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: nasRadiusB.id, ipKind: 'cgnat',
  });
  // fix wave 1 (S1.5): pool PUBLIC cargado — clasifica la IP actual (rango disjunto del resto).
  netRepo.seedNetwork({
    id: 'net-pub', network: '190.15.242.0/24', gateway: '190.15.242.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'Públicas corporativas', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-pub', name: 'publicas', networkId: 'net-pub',
    rangeStart: '190.15.242.2', rangeEnd: '190.15.242.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: null, ipKind: 'public',
  });
  // mini fix wave (ajuste 9 / S1.5 FAIL-CLOSED): pool CGNAT del NAS ORIGEN cubriendo OLD_IP —
  // el guard ahora exige clasificación POSITIVA como cgnat para pasar sin force.
  netRepo.seedNetwork({
    id: 'net-a', network: '100.64.60.0/24', gateway: '100.64.60.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: 'CGNAT NAS A (origen)', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  netRepo.seedPool({
    id: 'pool-a', name: 'cgnat-nas-a', networkId: 'net-a',
    rangeStart: '100.64.60.2', rangeEnd: '100.64.60.254',
    type: 'static', assignedCount: null, totalCount: 253, nasId: RADIUS_NAS_A, ipKind: 'cgnat',
  });

  // fix wave 1: NAS radius C sin NINGÚN pool cgnat → FindFreeIp lanza NO_POOL_FOR_NAS_TYPE.
  const nasRadiusC = await nasRepo.createNasServer({
    name: 'NAS Radius C (sin pool)',
    type: 'radius_orchestrator',
    ipAddress: '10.0.0.7',
    radiusSecret: 'x',
    nasIpAddress: '10.0.0.7',
    apiPort: null,
    apiLogin: null,
    apiPassword: null,
    status: 'active',
    lastSeen: null,
    clientCount: 0,
    description: 'destino radius sin pools',
  });

  const findFreeIp = new FindFreeIp(netRepo, nasRepo, routerGw, orchestrator);
  const legacyMove = new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo);
  const movePppoeToNas = new MovePppoeToNas(
    pppoeRepo, nasRepo, orchestrator, findFreeIp, legacyMove, moveEvents, catalogRepo, eventRepo, netRepo,
  );
  const listMoveEvents = new ListPppoeNasMoveEvents(moveEvents, nasRepo);

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
    undefined, // terminatePppoeService
    undefined, // getPppoeCallerId
    undefined, // listAllPppoeServices
    undefined, // listInternetServiceHistory
    undefined, // listInternetActivationOperators
    undefined, // createPppoeStandalone
    undefined, // renamePppoeUsername
    movePppoeToNas,
    listMoveEvents,
  ));
  app.use(errorHandler);

  return {
    app, pppoeRepo, moveEvents, nasRadiusB, nasRadiusC,
    readUserId: readUser.id, manageUserId: manageUser.id, nobodyUserId: nobodyUser.id,
    networkUserId: networkUser.id,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedPppoe(
  fx: Fixture,
  opts?: { username?: string; nasId?: string; remoteAddress?: string | null; contractId?: string | null },
) {
  return fx.pppoeRepo.upsertByUsername({
    username: opts?.username ?? 'moveuser',
    password: 'secret',
    profile: 'IP-Air-10M',
    nasId: opts?.nasId ?? RADIUS_NAS_A,
    status: 'enabled',
    ipMode: 'fixed',
    remoteAddress: opts?.remoteAddress !== undefined ? opts.remoteAddress : OLD_IP,
    contractId: opts?.contractId ?? null,
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// POST /api/pppoe/:id/move — radius-aware (MovePppoeToNas)
// ════════════════════════════════════════════════════════════════════════════════

describe('POST /api/pppoe/:id/move (radius-aware)', () => {
  it('401 sin auth', async () => {
    const fx = await buildApp();
    expect((await request(fx.app).post('/api/pppoe/x/move').send({ nasId: '2' })).status).toBe(401);
  });

  it('403 con pppoe.read solo (gate pppoe.manage)', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasRadiusB.id }), fx.readUserId);
    expect(res.status).toBe(403);
  });

  it('move radius→radius exitoso → 200 con nasId destino + IP NUEVA del pool + ipMode=fixed (sin password)', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasRadiusB.id }), fx.manageUserId);
    expect(res.status).toBe(200);
    expect(res.body.nasId).toBe(fx.nasRadiusB.id);
    expect(res.body.remoteAddress).toBe('100.64.43.3'); // .2 tomada → primera libre
    expect(res.body.ipMode).toBe('fixed');
    expect(res.body.password).toBeUndefined();
  });

  it('move exitoso registra el PppoeNasMoveEvent manual/moved con el actor autenticado', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx);
    await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasRadiusB.id }), fx.manageUserId);
    const events = fx.moveEvents.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      username: 'moveuser',
      trigger: 'manual',
      outcome: 'moved',
      fromIp: OLD_IP,
      toIp: '100.64.43.3',
      actorName: 'operador', // username del EchoAuthProvider
    });
  });

  it('servicio inexistente → 404 PPPOE_NOT_FOUND', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).post('/api/pppoe/ghost/move').send({ nasId: fx.nasRadiusB.id }), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PPPOE_NOT_FOUND');
  });

  it('NAS destino inexistente → 404 NAS_NOT_FOUND', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: 'ghost-nas' }), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NAS_NOT_FOUND');
  });

  it('pool destino LLENO → 422 NO_FREE_IP (status del errorHandler, fuente ÚNICA) y el cliente queda como estaba', async () => {
    const fx = await buildApp({
      poolRange: { start: '100.64.43.2', end: '100.64.43.3' },
      assignedIps: ['100.64.43.2', '100.64.43.3'],
    });
    const s = await seedPppoe(fx);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasRadiusB.id }), fx.manageUserId);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NO_FREE_IP');
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(RADIUS_NAS_A);
    expect(row!.remoteAddress).toBe(OLD_IP);
  });

  it('destino radius SIN pool cgnat → 404 NO_POOL_FOR_NAS_TYPE (status del errorHandler)', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasRadiusC.id }), fx.manageUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NO_POOL_FOR_NAS_TYPE');
  });

  it('servicio terminated → 409 PPPOE_TERMINATED (via errorHandler)', async () => {
    const fx = await buildApp();
    const s = await fx.pppoeRepo.upsertByUsername({
      username: 'terminated-user', password: 'x', nasId: RADIUS_NAS_A,
      status: 'terminated', ipMode: 'fixed', remoteAddress: null, contractId: null,
    });
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasRadiusB.id }), fx.manageUserId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_TERMINATED');
  });

  it('S1.6: orchestrator RECHAZA la Framed-IP (colisión persistente) → 409 ORCHESTRATOR_REJECTED, la request NO cuelga', async () => {
    class RejectFramedIpOrchestrator extends InMemoryRadiusOrchestratorGateway {
      override async changeFramedIp(username: string, framedIp: string | null): Promise<void> {
        this.calls.push({ op: 'changeFramedIp', username, arg: { framedIp } });
        throw new OrchestratorRejectedError(409, { detail: 'FramedIpAlreadyAssigned' });
      }
    }
    const fx = await buildApp({
      orchestrator: new RejectFramedIpOrchestrator({ assignedIps: ['100.64.43.2', OLD_IP] }),
    });
    const s = await seedPppoe(fx);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasRadiusB.id }), fx.manageUserId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORCHESTRATOR_REJECTED');
  });

  it('error DESCONOCIDO del use case → 500 INTERNAL_ERROR, la request NO cuelga (next(err), nunca throw)', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx);
    fx.pppoeRepo.findById = async () => { throw new Error('boom inesperado'); };
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasRadiusB.id }), fx.manageUserId);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('S1.5: IP actual PÚBLICA sin force → 409 PPPOE_MOVE_PUBLIC_IP y nada cambió', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx, { remoteAddress: '190.15.242.10' });
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasRadiusB.id }), fx.manageUserId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_MOVE_PUBLIC_IP');
    const row = await fx.pppoeRepo.findById(s.id);
    expect(row!.nasId).toBe(RADIUS_NAS_A);
    expect(row!.remoteAddress).toBe('190.15.242.10');
    expect(fx.moveEvents.all()).toHaveLength(0);
  });

  it('S1.5: IP actual PÚBLICA con force: true → 200 con IP nueva del pool cgnat', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx, { remoteAddress: '190.15.242.10' });
    const res = await asUser(
      request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasRadiusB.id, force: true }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.nasId).toBe(fx.nasRadiusB.id);
    expect(res.body.remoteAddress).toBe('100.64.43.3');
  });

  it('move mixto radius→legacy → 409 PPPOE_MOVE_MIXED_NAS_TYPES', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx); // origen radius
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: MK_NAS }), fx.manageUserId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_MOVE_MIXED_NAS_TYPES');
  });

  it('orchestrator caído → 502 ORCHESTRATOR_UNREACHABLE', async () => {
    const fx = await buildApp({ unreachableUsers: ['downuser'] });
    const s = await seedPppoe(fx, { username: 'downuser' });
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({ nasId: fx.nasRadiusB.id }), fx.manageUserId);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ORCHESTRATOR_UNREACHABLE');
  });

  it('body sin nasId → 422 VALIDATION_ERROR', async () => {
    const fx = await buildApp();
    const s = await seedPppoe(fx);
    const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/move`).send({}), fx.manageUserId);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// GET /api/pppoe/nas-move-events — registro visible (gate pppoe.read)
// ════════════════════════════════════════════════════════════════════════════════

describe('GET /api/pppoe/nas-move-events (network.read — tabs vecinos de la page de auditoria)', () => {
  it('401 sin auth', async () => {
    const fx = await buildApp();
    expect((await request(fx.app).get('/api/pppoe/nas-move-events')).status).toBe(401);
  });

  it('403 sin network.read', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events'), fx.nobodyUserId);
    expect(res.status).toBe(403);
  });

  it('403 con pppoe.read SOLO: el listado gatea network.read (alineado a los tabs vecinos de la page de auditoria — un NOC con network.read debe verlo; pppoe.read no alcanza)', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events'), fx.readUserId);
    expect(res.status).toBe(403);
  });

  it('200 con network.read: wire contract campo por campo {items,total,page,limit}', async () => {
    const fx = await buildApp();
    await fx.moveEvents.record({
      username: 'user1', pppoeServiceId: 'svc-1',
      fromNasId: RADIUS_NAS_A, toNasId: fx.nasRadiusB.id,
      fromIp: OLD_IP, toIp: '100.64.43.3',
      trigger: 'manual', outcome: 'moved', reason: null, actorName: 'operador',
    });

    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events'), fx.networkUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(Object.keys(item).sort()).toEqual(
      ['actorName', 'createdAt', 'fromIp', 'fromNas', 'id', 'outcome', 'reason', 'toIp', 'toNas', 'trigger', 'username'],
    );
    expect(item.fromNas).toEqual({ id: RADIUS_NAS_A, name: 'MikroTik sucursal' });
    expect(item.toNas).toEqual({ id: fx.nasRadiusB.id, name: 'NAS Radius B' });
    expect(item.username).toBe('user1');
    expect(item.fromIp).toBe(OLD_IP);
    expect(item.toIp).toBe('100.64.43.3');
    expect(item.trigger).toBe('manual');
    expect(item.outcome).toBe('moved');
    expect(item.actorName).toBe('operador');
  });

  it('S10.4: ?outcome=failed_no_free_ip devuelve SOLO los fallos', async () => {
    const fx = await buildApp();
    await fx.moveEvents.record({ username: 'ok1', trigger: 'manual', outcome: 'moved' });
    await fx.moveEvents.record({ username: 'fail1', trigger: 'auto', outcome: 'failed_no_free_ip' });

    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events?outcome=failed_no_free_ip'), fx.networkUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].username).toBe('fail1');
    expect(res.body.items[0].outcome).toBe('failed_no_free_ip');
  });

  it('filtros trigger + username y paginado page/limit', async () => {
    const fx = await buildApp();
    await fx.moveEvents.record({ username: 'juan.perez', trigger: 'manual', outcome: 'moved' });
    await fx.moveEvents.record({ username: 'maria.auto', trigger: 'auto', outcome: 'moved' });
    await fx.moveEvents.record({ username: 'pedro.auto', trigger: 'auto', outcome: 'moved' });

    const byTrigger = await asUser(request(fx.app).get('/api/pppoe/nas-move-events?trigger=auto'), fx.networkUserId);
    expect(byTrigger.body.total).toBe(2);

    const byUser = await asUser(request(fx.app).get('/api/pppoe/nas-move-events?username=perez'), fx.networkUserId);
    expect(byUser.body.total).toBe(1);
    expect(byUser.body.items[0].username).toBe('juan.perez');

    const paged = await asUser(request(fx.app).get('/api/pppoe/nas-move-events?page=2&limit=1&trigger=auto'), fx.networkUserId);
    expect(paged.body.total).toBe(2);
    expect(paged.body.page).toBe(2);
    expect(paged.body.limit).toBe(1);
    expect(paged.body.items).toHaveLength(1);
  });

  it('limit > 100 se clampea a 100', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events?limit=500'), fx.networkUserId);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
  });

  it('la ruta literal NO es sombreada por catch-alls /pppoe/:id (devuelve el shape del listado)', async () => {
    const fx = await buildApp();
    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events'), fx.networkUserId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.total).toBe('number');
  });

  it('repo del listado roto → 500 INTERNAL_ERROR, la request NO cuelga (handler con next(err))', async () => {
    const fx = await buildApp();
    fx.moveEvents.list = async () => { throw new Error('boom listado'); };
    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events'), fx.networkUserId);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// W2 — S10.2/S10.3: las filas de fallo/skip del WATCHER (trigger auto) son visibles
// por el endpoint (el registro no puede vivir solo en el stdout del container).
// Las filas se siembran con el shape EXACTO que producen AutoMovePppoe (skips) y
// el core MovePppoeToNas (fallos) en trigger 'auto'.
// ════════════════════════════════════════════════════════════════════════════════

describe('GET /api/pppoe/nas-move-events — outcomes del watcher W2 (S10.2/S10.3)', () => {
  it('S10.2: auto-move con pool lleno → la fila failed_no_free_ip es visible y filtrable', async () => {
    const fx = await buildApp();
    await fx.moveEvents.record({
      username: 'w2user', pppoeServiceId: 'svc-1', fromNasId: RADIUS_NAS_A, toNasId: fx.nasRadiusB.id,
      fromIp: OLD_IP, toIp: null, trigger: 'auto', outcome: 'failed_no_free_ip',
      reason: 'NO_FREE_IP', actorName: 'sistema',
    });

    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events?outcome=failed_no_free_ip'), fx.networkUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      username: 'w2user',
      trigger: 'auto',
      outcome: 'failed_no_free_ip',
      actorName: 'sistema',
      toNas: { id: fx.nasRadiusB.id, name: 'NAS Radius B' },
    });
  });

  it('S10.3: auto-move skipped por IP pública → la fila skipped_public es visible con su reason', async () => {
    const fx = await buildApp();
    await fx.moveEvents.record({
      username: 'w2pub', pppoeServiceId: 'svc-2', fromNasId: RADIUS_NAS_A, toNasId: fx.nasRadiusB.id,
      fromIp: '190.15.242.10', toIp: null, trigger: 'auto', outcome: 'skipped_public',
      reason: 'public_pool', actorName: 'sistema',
    });

    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events?outcome=skipped_public'), fx.networkUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      username: 'w2pub',
      trigger: 'auto',
      outcome: 'skipped_public',
      reason: 'public_pool',
      fromIp: '190.15.242.10',
    });
  });

  it('skipped_unknown_nas (toNasId null) → visible con toNas null (NAS fantasma sin inventario)', async () => {
    const fx = await buildApp();
    await fx.moveEvents.record({
      username: 'w2ghost', pppoeServiceId: 'svc-3', fromNasId: RADIUS_NAS_A, toNasId: null,
      fromIp: OLD_IP, toIp: null, trigger: 'auto', outcome: 'skipped_unknown_nas',
      reason: 'nas_ip_not_registered:10.99.99.99', actorName: 'sistema',
    });

    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events?outcome=skipped_unknown_nas'), fx.networkUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].toNas).toBeNull();
    expect(res.body.items[0].reason).toBe('nas_ip_not_registered:10.99.99.99');
  });

  // D-W2.5 items 4/5: los 2 outcomes NUEVOS del watcher endurecido entran al union del port y
  // el endpoint los devuelve/filtra (degradan graceful en el FE actual: OutcomeBadge renderiza
  // texto plano para desconocidos; labels/filtros llegan en la wave FE del flag).
  it('D-W2.5: skipped_stale_session (freshness gate C1) es visible y filtrable por el endpoint', async () => {
    const fx = await buildApp();
    await fx.moveEvents.record({
      username: 'w2stale', pppoeServiceId: 'svc-4', fromNasId: RADIUS_NAS_A, toNasId: fx.nasRadiusB.id,
      fromIp: OLD_IP, toIp: null, trigger: 'auto', outcome: 'skipped_stale_session',
      reason: 'winner_session_stale_gt_72h', actorName: 'sistema',
    });

    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events?outcome=skipped_stale_session'), fx.networkUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      username: 'w2stale',
      trigger: 'auto',
      outcome: 'skipped_stale_session',
      reason: 'winner_session_stale_gt_72h',
      toNas: { id: fx.nasRadiusB.id, name: 'NAS Radius B' },
    });
  });

  it('D-W2.5: skipped_nas_conflict (multi-NAS persistente W7) es visible y filtrable, con toNas null', async () => {
    const fx = await buildApp();
    await fx.moveEvents.record({
      username: 'w2conflict', pppoeServiceId: 'svc-5', fromNasId: RADIUS_NAS_A, toNasId: null,
      fromIp: OLD_IP, toIp: null, trigger: 'auto', outcome: 'skipped_nas_conflict',
      reason: 'sessions_on_multiple_nas:10.0.0.5,10.0.0.6', actorName: 'sistema',
    });

    const res = await asUser(request(fx.app).get('/api/pppoe/nas-move-events?outcome=skipped_nas_conflict'), fx.networkUserId);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      username: 'w2conflict',
      trigger: 'auto',
      outcome: 'skipped_nas_conflict',
      reason: 'sessions_on_multiple_nas:10.0.0.5,10.0.0.6',
    });
    expect(res.body.items[0].toNas).toBeNull();
  });
});

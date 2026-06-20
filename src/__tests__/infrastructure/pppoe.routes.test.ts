/**
 * pppoe.routes.test.ts — supertest integration para las rutas PPPoE.
 *
 * Cubre:
 *   - 401 sin auth
 *   - 403 sin permiso (pppoe.manage / pppoe.read)
 *   - GET /contracts/:contractId/pppoe → 200 con lista (sin password)
 *   - POST /contracts/:contractId/pppoe → 201 OK / 409 dup / 502 router caído / 422 validación
 *   - PATCH /pppoe/:id → 200 OK / 404 not found / 502 router caído
 *   - POST /pppoe/:id/move → 200 OK / 502 destino caído
 *   - DELETE /pppoe/:id → 204 soft-deactivate / 404 not found
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

import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { DeactivatePppoeService } from '@application/use-cases/DeactivatePppoeService';
import { EnforcePppoeService } from '@application/use-cases/EnforcePppoeService';
import { PreviewEnforcement } from '@application/use-cases/PreviewEnforcement';
import { RunBulkEnforcement } from '@application/use-cases/RunBulkEnforcement';
import { ServiceCutRunner } from '@infrastructure/scheduling/ServiceCutRunner';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

// ── EchoAuthProvider — convierte el cookie value en { id } ──────────────────
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

// ── Fixture ──────────────────────────────────────────────────────────────────

// NAS seed: el InMemoryNasRepository tiene id='1' con ipAddress='192.168.1.1'
const NAS_ID      = '1';
const NAS_IP      = '192.168.1.1';
const CONTRACT_ID = 'contract-1';

interface Fixture {
  app: express.Express;
  pppoeRepo:   InMemoryPppoeServiceRepository;
  routerGw:    InMemoryRouterGateway;
  nasRepo:     InMemoryNasRepository;
  readUserId:  string;
  manageUserId: string;
  noPermUserId: string;
}

async function buildApp(opts?: { unreachableNas?: string[] }): Promise<Fixture> {
  // RBAC plumbing
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher       = new InMemoryPasswordHasher();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  // Wire listRolesForUser / listPermissionsForUser (mismo patrón que contractServices.routes.test)
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

  const readUser    = await mkUser('reader');
  const manageUser  = await mkUser('manager');
  const noPermUser  = await mkUser('noperm');

  await userRoleRepo.assign(readUser.id, readerRole.id);
  await userRoleRepo.assign(manageUser.id, managerRole.id);
  // noPermUser: sin roles → 403 siempre

  // PPPoE infra
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const routerGw  = new InMemoryRouterGateway({ unreachable: opts?.unreachableNas });
  const nasRepo   = new InMemoryNasRepository();

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
    undefined, // sessionRepo: stateless en tests
    requirePerm,
    new ListPppoeByContract(pppoeRepo),
    new CreatePppoeService(pppoeRepo, routerGw, nasRepo, new InMemoryRadiusOrchestratorGateway()),
    new UpdatePppoeService(pppoeRepo, routerGw, nasRepo),
    new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo),
    new DeactivatePppoeService(pppoeRepo, routerGw, nasRepo),
    enforce,
    preview,
    runner,
    batchRepo,
  ));
  app.use(errorHandler);

  return {
    app,
    pppoeRepo,
    routerGw,
    nasRepo,
    readUserId:   readUser.id,
    manageUserId: manageUser.id,
    noPermUserId: noPermUser.id,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ── Helpers de seed ──────────────────────────────────────────────────────────

async function seedService(pppoeRepo: InMemoryPppoeServiceRepository, opts?: {
  username?: string;
  contractId?: string;
  nasId?: string;
}) {
  return pppoeRepo.upsertByUsername({
    username: opts?.username ?? 'user1',
    password: 'secret',
    profile: null,
    remoteAddress: null,
    nasId: opts?.nasId ?? NAS_ID,
    contractId: opts?.contractId ?? CONTRACT_ID,
    status: 'enabled',
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// AUTH — 401 sin auth
// ════════════════════════════════════════════════════════════════════════════════

describe('401 — sin autenticación en todas las rutas PPPoE', () => {
  let app: express.Express;

  beforeEach(async () => {
    ({ app } = await buildApp());
  });

  it('GET /contracts/:id/pppoe → 401', async () => {
    const res = await request(app).get(`/api/contracts/${CONTRACT_ID}/pppoe`);
    expect(res.status).toBe(401);
  });

  it('POST /contracts/:id/pppoe → 401', async () => {
    const res = await request(app).post(`/api/contracts/${CONTRACT_ID}/pppoe`).send({ username: 'u', password: 'p', nasId: NAS_ID });
    expect(res.status).toBe(401);
  });

  it('PATCH /pppoe/:id → 401', async () => {
    const res = await request(app).patch('/api/pppoe/some-id').send({ profile: 'IP-Air' });
    expect(res.status).toBe(401);
  });

  it('POST /pppoe/:id/move → 401', async () => {
    const res = await request(app).post('/api/pppoe/some-id/move').send({ nasId: '2' });
    expect(res.status).toBe(401);
  });

  it('DELETE /pppoe/:id → 401', async () => {
    const res = await request(app).delete('/api/pppoe/some-id');
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// RBAC — 403 sin permiso manage
// ════════════════════════════════════════════════════════════════════════════════

describe('403 — sin permiso pppoe.manage', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await buildApp();
  });

  it('POST /contracts/:id/pppoe con pppoe.read solo → 403', async () => {
    const res = await asUser(
      request(fx.app).post(`/api/contracts/${CONTRACT_ID}/pppoe`).send({ username: 'u', password: 'p', nasId: NAS_ID }),
      fx.readUserId,
    );
    expect(res.status).toBe(403);
  });

  it('GET /contracts/:id/pppoe sin ningún perm → 403', async () => {
    const res = await asUser(
      request(fx.app).get(`/api/contracts/${CONTRACT_ID}/pppoe`),
      fx.noPermUserId,
    );
    expect(res.status).toBe(403);
  });

  it('PATCH /pppoe/:id sin manage → 403', async () => {
    const res = await asUser(
      request(fx.app).patch('/api/pppoe/some-id').send({ profile: 'IP-Air' }),
      fx.readUserId,
    );
    expect(res.status).toBe(403);
  });

  it('POST /pppoe/:id/move sin manage → 403', async () => {
    const res = await asUser(
      request(fx.app).post('/api/pppoe/some-id/move').send({ nasId: '2' }),
      fx.readUserId,
    );
    expect(res.status).toBe(403);
  });

  it('DELETE /pppoe/:id sin manage → 403', async () => {
    const res = await asUser(
      request(fx.app).delete('/api/pppoe/some-id'),
      fx.readUserId,
    );
    expect(res.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// GET /contracts/:contractId/pppoe
// ════════════════════════════════════════════════════════════════════════════════

describe('GET /api/contracts/:contractId/pppoe', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await buildApp();
  });

  it('devuelve lista vacía cuando no hay PPPoE', async () => {
    const res = await asUser(
      request(fx.app).get(`/api/contracts/${CONTRACT_ID}/pppoe`),
      fx.readUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('devuelve los servicios del contrato SIN password', async () => {
    await seedService(fx.pppoeRepo, { username: 'alice', contractId: CONTRACT_ID });
    await seedService(fx.pppoeRepo, { username: 'bob', contractId: CONTRACT_ID });
    // otro contrato — no debe aparecer
    await seedService(fx.pppoeRepo, { username: 'eve', contractId: 'other-contract' });

    const res = await asUser(
      request(fx.app).get(`/api/contracts/${CONTRACT_ID}/pppoe`),
      fx.readUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const dto of res.body) {
      expect(dto.password).toBeUndefined();  // ← frontera de seguridad
      expect(dto.username).toBeDefined();
      expect(dto.id).toBeDefined();
    }
  });

  it('pppoe.manage también puede leer', async () => {
    await seedService(fx.pppoeRepo, { username: 'user1', contractId: CONTRACT_ID });
    const res = await asUser(
      request(fx.app).get(`/api/contracts/${CONTRACT_ID}/pppoe`),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// POST /contracts/:contractId/pppoe
// ════════════════════════════════════════════════════════════════════════════════

describe('POST /api/contracts/:contractId/pppoe', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await buildApp();
  });

  it('create exitosa → 201 con DTO (sin password)', async () => {
    const res = await asUser(
      request(fx.app)
        .post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({ username: 'clienteA', password: 'secret123', nasId: NAS_ID }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('clienteA');
    expect(res.body.status).toBe('enabled');
    expect(res.body.nasId).toBe(NAS_ID);
    expect(res.body.contractId).toBe(CONTRACT_ID);
    expect(res.body.password).toBeUndefined();
  });

  it('username duplicado → 409 PPPOE_USERNAME_TAKEN', async () => {
    await seedService(fx.pppoeRepo, { username: 'dup-user', contractId: CONTRACT_ID });

    const res = await asUser(
      request(fx.app)
        .post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({ username: 'dup-user', password: 'otro', nasId: NAS_ID }),
      fx.manageUserId,
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PPPOE_USERNAME_TAKEN');
  });

  it('router caído → 502 ROUTER_UNREACHABLE', async () => {
    // Rebuild app con NAS_IP en la lista de unreachable
    const fx2 = await buildApp({ unreachableNas: [NAS_IP] });

    const res = await asUser(
      request(fx2.app)
        .post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({ username: 'cliente-new', password: 'pw', nasId: NAS_ID }),
      fx2.manageUserId,
    );
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ROUTER_UNREACHABLE');
  });

  it('NAS inexistente → 404 NAS_NOT_FOUND', async () => {
    const res = await asUser(
      request(fx.app)
        .post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({ username: 'u', password: 'p', nasId: 'nas-99' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NAS_NOT_FOUND');
  });

  it('body inválido (falta username) → 422 VALIDATION_ERROR', async () => {
    const res = await asUser(
      request(fx.app)
        .post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({ password: 'pw', nasId: NAS_ID }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('body inválido (falta password) → 422 VALIDATION_ERROR', async () => {
    const res = await asUser(
      request(fx.app)
        .post(`/api/contracts/${CONTRACT_ID}/pppoe`)
        .send({ username: 'u', nasId: NAS_ID }),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PATCH /pppoe/:id
// ════════════════════════════════════════════════════════════════════════════════

describe('PATCH /api/pppoe/:id', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await buildApp();
  });

  it('update exitoso → 200 con DTO actualizado', async () => {
    const s = await seedService(fx.pppoeRepo, { username: 'u1' });

    const res = await asUser(
      request(fx.app)
        .patch(`/api/pppoe/${s.id}`)
        .send({ profile: 'IP-Air-5M' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.profile).toBe('IP-Air-5M');
    expect(res.body.password).toBeUndefined();
  });

  it('PPPoE no existe → 404 PPPOE_NOT_FOUND', async () => {
    const res = await asUser(
      request(fx.app)
        .patch('/api/pppoe/no-existe')
        .send({ profile: 'IP-Air' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PPPOE_NOT_FOUND');
  });

  it('router caído → 502 ROUTER_UNREACHABLE', async () => {
    const fx2 = await buildApp({ unreachableNas: [NAS_IP] });
    const s = await seedService(fx2.pppoeRepo);

    const res = await asUser(
      request(fx2.app)
        .patch(`/api/pppoe/${s.id}`)
        .send({ profile: 'IP-Air' }),
      fx2.manageUserId,
    );
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ROUTER_UNREACHABLE');
  });

  it('body vacío → 422 VALIDATION_ERROR', async () => {
    const s = await seedService(fx.pppoeRepo);
    const res = await asUser(
      request(fx.app)
        .patch(`/api/pppoe/${s.id}`)
        .send({}),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// POST /pppoe/:id/move
// ════════════════════════════════════════════════════════════════════════════════

describe('POST /api/pppoe/:id/move', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await buildApp();
  });

  it('move exitoso → 200 con nasId actualizado', async () => {
    const s = await seedService(fx.pppoeRepo, { nasId: NAS_ID });

    // Seed el NAS destino en el in-memory nasRepo
    await fx.nasRepo.createNasServer({
      name: 'Destino',
      type: 'mikrotik_api',
      ipAddress: '10.0.0.1',
      radiusSecret: 'x',
      nasIpAddress: '10.0.0.1',
      apiPort: 8728,
      apiLogin: 'admin',
      apiPassword: 'pw',
      status: 'active',
      lastSeen: new Date().toISOString(),
      clientCount: 0,
      description: 'Destino',
    });

    const allNas = await fx.nasRepo.findAllNasServers();
    const destNas = allNas.find(n => n.ipAddress === '10.0.0.1')!;

    const res = await asUser(
      request(fx.app)
        .post(`/api/pppoe/${s.id}/move`)
        .send({ nasId: destNas.id }),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
    expect(res.body.nasId).toBe(destNas.id);
  });

  it('destino caído → 502 ROUTER_UNREACHABLE', async () => {
    const fx2 = await buildApp({ unreachableNas: ['10.0.0.99'] });
    const s = await seedService(fx2.pppoeRepo, { nasId: NAS_ID });

    // Seed el NAS caído en el nasRepo
    await fx2.nasRepo.createNasServer({
      name: 'Destino caído',
      type: 'mikrotik_api',
      ipAddress: '10.0.0.99',
      radiusSecret: 'x',
      nasIpAddress: '10.0.0.99',
      apiPort: 8728,
      apiLogin: 'a',
      apiPassword: 'p',
      status: 'active',
      lastSeen: new Date().toISOString(),
      clientCount: 0,
      description: '',
    });
    const allNas = await fx2.nasRepo.findAllNasServers();
    const downNas = allNas.find(n => n.ipAddress === '10.0.0.99')!;

    const res = await asUser(
      request(fx2.app)
        .post(`/api/pppoe/${s.id}/move`)
        .send({ nasId: downNas.id }),
      fx2.manageUserId,
    );
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ROUTER_UNREACHABLE');
  });

  it('body sin nasId → 422 VALIDATION_ERROR', async () => {
    const s = await seedService(fx.pppoeRepo);
    const res = await asUser(
      request(fx.app)
        .post(`/api/pppoe/${s.id}/move`)
        .send({}),
      fx.manageUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// DELETE /pppoe/:id — baja soft
// ════════════════════════════════════════════════════════════════════════════════

describe('DELETE /api/pppoe/:id', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await buildApp();
  });

  it('soft-deactivate exitoso → 204', async () => {
    const s = await seedService(fx.pppoeRepo, { username: 'to-delete' });

    const res = await asUser(
      request(fx.app).delete(`/api/pppoe/${s.id}`),
      fx.manageUserId,
    );
    expect(res.status).toBe(204);

    // La fila sigue en repo pero status='disabled'
    const updated = await fx.pppoeRepo.findById(s.id);
    expect(updated?.status).toBe('disabled');
  });

  it('PPPoE no existe → 404 PPPOE_NOT_FOUND', async () => {
    const res = await asUser(
      request(fx.app).delete('/api/pppoe/inexistente'),
      fx.manageUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PPPOE_NOT_FOUND');
  });

  it('router caído en deactivate → 502 ROUTER_UNREACHABLE', async () => {
    const fx2 = await buildApp({ unreachableNas: [NAS_IP] });
    const s = await seedService(fx2.pppoeRepo);

    const res = await asUser(
      request(fx2.app).delete(`/api/pppoe/${s.id}`),
      fx2.manageUserId,
    );
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ROUTER_UNREACHABLE');
  });
});

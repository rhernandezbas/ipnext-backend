/**
 * pppoe.enforce.routes.test.ts — supertest para las rutas de CORTE (Fase C).
 *
 * Cubre: 401/403 (pppoe.cut), POST /pppoe/:id/enforce (200/404/502),
 * POST /pppoe/enforce/preview (200), POST /pppoe/enforce/bulk (202 + 409 lock),
 * GET /pppoe/enforce/bulk/:id (progreso).
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
import { ServiceCutRunner, SERVICE_CUT_LOCK_KEY } from '@infrastructure/scheduling/ServiceCutRunner';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

const NAS_ID = '1';
const NAS_IP = '192.168.1.1';

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

interface Fixture {
  app: express.Express;
  pppoeRepo: InMemoryPppoeServiceRepository;
  router: InMemoryRouterGateway;
  batchRepo: InMemoryServiceCutBatchRepository;
  lock: InMemoryDistributedLock;
  cutUserId: string;
  noPermUserId: string;
}

async function buildApp(opts?: { unreachableNas?: string[] }): Promise<Fixture> {
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
  const cutPerm = await permRepo.seed({ moduleCode: 'pppoe', action: 'cut' });
  await rolePermRepo.grant(cutterRole.id, cutPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const cutUser = await mkUser('cutter');
  const noPermUser = await mkUser('noperm');
  await userRoleRepo.assign(cutUser.id, cutterRole.id);

  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const router    = new InMemoryRouterGateway({ unreachable: opts?.unreachableNas });
  const nasRepo   = new InMemoryNasRepository();
  const batchRepo = new InMemoryServiceCutBatchRepository();
  const lock      = new InMemoryDistributedLock();

  const enforce = new EnforcePppoeService(pppoeRepo, new RouterOsEnforcementAdapter(router, 'IP-REDUCCION'), nasRepo);
  const preview = new PreviewEnforcement(pppoeRepo);
  const bulk    = new RunBulkEnforcement(pppoeRepo, enforce, batchRepo, { throttleMs: 0 });
  const runner  = new ServiceCutRunner(bulk, batchRepo, lock);

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api', createPppoeRouter(
    new EchoAuthProvider(),
    undefined, // sessionRepo: stateless en tests
    requirePerm,
    new ListPppoeByContract(pppoeRepo),
    new CreatePppoeService(pppoeRepo, router, nasRepo),
    new UpdatePppoeService(pppoeRepo, router, nasRepo),
    new MovePppoeServiceToRouter(pppoeRepo, router, nasRepo),
    new DeactivatePppoeService(pppoeRepo, router, nasRepo),
    enforce,
    preview,
    runner,
    batchRepo,
  ));
  app.use(errorHandler);

  return { app, pppoeRepo, router, batchRepo, lock, cutUserId: cutUser.id, noPermUserId: noPermUser.id };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

async function seedActive(fx: Fixture, username: string, contractId = 'c1') {
  const s = await fx.pppoeRepo.upsertByUsername({
    username, password: 'pw', profile: 'IP-Air', nasId: NAS_ID, contractId, status: 'enabled', enforcedState: 'active',
  });
  await fx.router.createSecret({ ipAddress: NAS_IP, apiPort: 8728 }, { username, password: 'pw', profile: 'IP-Air' });
  return s;
}

async function pollBatch(fx: Fixture, jobId: string): Promise<request.Response> {
  for (let i = 0; i < 30; i++) {
    const res = await asUser(request(fx.app).get(`/api/pppoe/enforce/bulk/${jobId}`), fx.cutUserId);
    if (res.body.status === 'done' || res.body.status === 'failed') return res;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('batch no terminó a tiempo');
}

describe('Rutas de enforcement PPPoE (Fase C)', () => {
  describe('401 / 403', () => {
    it('POST /pppoe/:id/enforce sin auth → 401', async () => {
      const fx = await buildApp();
      const res = await request(fx.app).post('/api/pppoe/x/enforce').send({ action: 'reduce' });
      expect(res.status).toBe(401);
    });

    it('POST /pppoe/enforce/preview sin pppoe.cut → 403', async () => {
      const fx = await buildApp();
      const res = await asUser(request(fx.app).post('/api/pppoe/enforce/preview').send({ action: 'reduce', target: 'debtors' }), fx.noPermUserId);
      expect(res.status).toBe(403);
    });

    it('POST /pppoe/enforce/bulk sin pppoe.cut → 403', async () => {
      const fx = await buildApp();
      const res = await asUser(request(fx.app).post('/api/pppoe/enforce/bulk').send({ action: 'reduce', target: 'debtors' }), fx.noPermUserId);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /pppoe/:id/enforce (individual)', () => {
    it('reduce → 200 con enforcedState=reduced', async () => {
      const fx = await buildApp();
      const s = await seedActive(fx, 'cli1');
      const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/enforce`).send({ action: 'reduce' }), fx.cutUserId);
      expect(res.status).toBe(200);
      expect(res.body.enforcedState).toBe('reduced');
      expect(res.body.password).toBeUndefined();
    });

    it('pppoe inexistente → 404', async () => {
      const fx = await buildApp();
      const res = await asUser(request(fx.app).post('/api/pppoe/no-existe/enforce').send({ action: 'reduce' }), fx.cutUserId);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PPPOE_NOT_FOUND');
    });

    it('router caído → 502', async () => {
      const fx = await buildApp({ unreachableNas: [NAS_IP] });
      const s = await fx.pppoeRepo.upsertByUsername({ username: 'cli1', password: 'pw', nasId: NAS_ID, contractId: 'c1', enforcedState: 'active' });
      const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/enforce`).send({ action: 'reduce' }), fx.cutUserId);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('ROUTER_UNREACHABLE');
    });

    it('action inválida → 422', async () => {
      const fx = await buildApp();
      const s = await seedActive(fx, 'cli1');
      const res = await asUser(request(fx.app).post(`/api/pppoe/${s.id}/enforce`).send({ action: 'nope' }), fx.cutUserId);
      expect(res.status).toBe(422);
    });
  });

  describe('POST /pppoe/enforce/preview', () => {
    it('debtors + reduce → 200 con total/byRouter/sample', async () => {
      const fx = await buildApp();
      await seedActive(fx, 'd1', 'cA');
      await seedActive(fx, 'd2', 'cB');
      fx.pppoeRepo.setContractClientStatus('cA', 'late');
      fx.pppoeRepo.setContractClientStatus('cB', 'late');

      const res = await asUser(request(fx.app).post('/api/pppoe/enforce/preview').send({ action: 'reduce', target: 'debtors' }), fx.cutUserId);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.byRouter[NAS_ID]).toBe(2);
      expect(Array.isArray(res.body.sample)).toBe(true);
    });

    it('target inválido → 422', async () => {
      const fx = await buildApp();
      const res = await asUser(request(fx.app).post('/api/pppoe/enforce/preview').send({ action: 'reduce', target: 123 }), fx.cutUserId);
      expect(res.status).toBe(422);
    });
  });

  describe('POST /pppoe/enforce/bulk + GET /pppoe/enforce/bulk/:id', () => {
    it('dispara batch → 202 {jobId}; progreso poleable hasta done', async () => {
      const fx = await buildApp();
      await seedActive(fx, 'd1', 'cA');
      await seedActive(fx, 'd2', 'cB');
      fx.pppoeRepo.setContractClientStatus('cA', 'late');
      fx.pppoeRepo.setContractClientStatus('cB', 'late');

      const res = await asUser(request(fx.app).post('/api/pppoe/enforce/bulk').send({ action: 'reduce', target: 'debtors' }), fx.cutUserId);
      expect(res.status).toBe(202);
      expect(res.body.jobId).toBeTruthy();

      const done = await pollBatch(fx, res.body.jobId);
      expect(done.body.status).toBe('done');
      expect(done.body.total).toBe(2);
      expect(done.body.doneCount).toBe(2);
      expect(Array.isArray(done.body.items)).toBe(true);
    });

    it('ya hay un batch corriendo (lock tomado) → 409', async () => {
      const fx = await buildApp();
      await fx.lock.tryAcquire(SERVICE_CUT_LOCK_KEY); // simula batch en curso
      const res = await asUser(request(fx.app).post('/api/pppoe/enforce/bulk').send({ action: 'reduce', target: 'debtors' }), fx.cutUserId);
      expect(res.status).toBe(409);
    });

    it('GET batch inexistente → 404', async () => {
      const fx = await buildApp();
      const res = await asUser(request(fx.app).get('/api/pppoe/enforce/bulk/no-existe'), fx.cutUserId);
      expect(res.status).toBe(404);
    });
  });
});

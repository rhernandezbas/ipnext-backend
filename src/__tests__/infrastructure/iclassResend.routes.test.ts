/**
 * T-20: Integration tests for GET /api/scheduling/iclass/nodes
 *       and POST /api/scheduling/:id/iclass/resend
 *
 * TDD pattern: RED first, then green after ListIClassNodes + routes + wiring.
 * Auth: EchoAuthProvider (cookie token = userId) + InMemory RBAC repos.
 *
 * Traza: REQ-NODES-1..4, REQ-RESEND-1, REQ-RESEND-7, REQ-RESEND-9, REQ-RBAC-RESEND-4.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryFeatureFlagRepository } from '../../infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassDispatchAttemptRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassDispatchAttemptRepository';
import { InMemoryRbacUserRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '../../infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '../../infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '../../infrastructure/http/middleware/requirePermission';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';

import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { SendTaskToIClass } from '../../application/use-cases/SendTaskToIClass';
import { ListIClassNodes } from '../../application/use-cases/ListIClassNodes';
import { ResendTaskToIClassWithNode } from '../../application/use-cases/ResendTaskToIClassWithNode';
import { EntityLookup } from '../../domain/ports/EntityLookup';

import { AuthProvider } from '../../domain/ports/AuthProvider';
import { User } from '../../domain/entities/auth';
import { Stage } from '../../domain/entities/workflow';
import type { RbacModuleCode, PermissionAction } from '../../domain/entities/rbac';

// ─── Stub lookups — accept any ID (FK identity not under test here) ────────

class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}
const anyLookup = new AnyLookup();

// ─── EchoAuthProvider: cookie token IS the userId ──────────────────────────

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

// ─── Stages setup ──────────────────────────────────────────────────────────

const WF = 'wf-iclass-resend';

const SEND_STAGE: Stage = {
  id: 'stage-send',
  workflowId: WF,
  name: 'Enviar a IClass',
  code: 'send_to_iclass',
  category: 'enProgreso',
  order: 5,
  color: null,
};

const REGISTERED_STAGE: Stage = {
  id: 'stage-registered',
  workflowId: WF,
  name: 'Registrado en IClass',
  code: 'registered_in_iclass',
  category: 'enProgreso',
  order: 6,
  color: null,
};

const DEFAULT_SO_TYPE = { id: 'so-t-1', code: 'INSTALL', active: true };
const DEFAULT_PROJECT_ID = 'proj-iclass';

// ─── RBAC fixture builder ──────────────────────────────────────────────────

async function buildRbac() {
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher       = new InMemoryPasswordHasher();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  // Wire listRolesForUser + listPermissionsForUser via in-memory pivots
  userRepo.listRolesForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const roles = await Promise.all(roleIds.map(id => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('../../domain/entities/rbac').RbacPermission[] = [];
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

  // Roles
  const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
  const resendRole     = await roleRepo.create({ code: 'resend_role', label: 'Resend Role', isSystem: false });

  // Permissions
  const resendPerm = await permRepo.seed({ moduleCode: 'scheduling', action: 'iclass_manual_resend' });
  await rolePermRepo.grant(resendRole.id, resendPerm.id);

  // Users
  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const superAdminUser = await mkUser('super');
  await userRoleRepo.assign(superAdminUser.id, superAdminRole.id);

  const resendUser = await mkUser('resender');
  await userRoleRepo.assign(resendUser.id, resendRole.id);

  const noPermUser = await mkUser('noperm');

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  return {
    requirePerm,
    superAdminUserId: superAdminUser.id,
    resendUserId: resendUser.id,
    noPermUserId: noPermUser.id,
  };
}

// ─── App builder ──────────────────────────────────────────────────────────

interface AppFixture {
  app: express.Express;
  tasks: InMemorySchedulingRepository;
  iclass: InMemoryIClassClient;
  attempts: InMemoryIClassDispatchAttemptRepository;
  superAdminUserId: string;
  resendUserId: string;
  noPermUserId: string;
}

async function buildApp(opts?: { iclassFails?: boolean }): Promise<AppFixture> {
  const { requirePerm, superAdminUserId, resendUserId, noPermUserId } = await buildRbac();

  const stageRepo = new InMemoryStageRepository();
  stageRepo.addDirect(SEND_STAGE);
  stageRepo.addDirect(REGISTERED_STAGE);

  const tasks = new InMemorySchedulingRepository(stageRepo);
  tasks.seedProject({ id: DEFAULT_PROJECT_ID, title: 'Proyecto IClass', iclassSoType: DEFAULT_SO_TYPE });

  const flags = new InMemoryFeatureFlagRepository();
  flags.seed('iclass-integration', true);

  const iclass = new InMemoryIClassClient();
  iclass.nodes = [
    { nodeId: 1001, code: 'Mercedes', description: 'Mercedes - Zona Norte' },
    { nodeId: 1002, code: 'Lujan', description: 'Lujan' },
  ];
  if (opts?.iclassFails) {
    iclass.failureMode = 'unavailable';
  }

  const attempts = new InMemoryIClassDispatchAttemptRepository();
  const authProvider = new EchoAuthProvider();

  const sendTaskToIClass = new SendTaskToIClass(tasks, flags, iclass, attempts);
  const moveTaskToStage = new MoveTaskToStage(tasks, stageRepo, sendTaskToIClass);

  const listIClassNodes = new ListIClassNodes(iclass);
  const resendTaskToIClassWithNode = new ResendTaskToIClassWithNode(tasks, flags, iclass, attempts, stageRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/scheduling', createSchedulingRouter(
    new ListTasks(tasks),
    new GetTask(tasks),
    new CreateTask(tasks, anyLookup, anyLookup, anyLookup, anyLookup, anyLookup),
    new UpdateTask(tasks, anyLookup, anyLookup, anyLookup, anyLookup, anyLookup),
    new DeleteTask(tasks),
    moveTaskToStage,
    authProvider,
    undefined, // sessionRepo
    stageRepo,
    undefined, // checklist
    undefined, // setTaskInventoryReview
    undefined, // bulkMoveTasksToStage
    { listIClassNodes, resendTaskToIClassWithNode, requirePerm },
  ));
  app.use(errorHandler);

  return { app, tasks, iclass, attempts, superAdminUserId, resendUserId, noPermUserId };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ─── GET /api/scheduling/iclass/nodes ─────────────────────────────────────

describe('GET /api/scheduling/iclass/nodes', () => {
  it('REQ-NODES-3: without token → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/scheduling/iclass/nodes');
    expect(res.status).toBe(401);
  });

  it('REQ-NODES-4: with valid token but no iclass_manual_resend perm → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/scheduling/iclass/nodes'), noPermUserId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('REQ-NODES-2, REQ-NODES-4: with iclass_manual_resend perm → 200 with nodes array', async () => {
    const { app, resendUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/scheduling/iclass/nodes'), resendUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nodes');
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(res.body.nodes).toHaveLength(2);
    expect(res.body.nodes[0]).toEqual({ code: 'Mercedes', description: 'Mercedes - Zona Norte' });
    expect(res.body.nodes[1]).toEqual({ code: 'Lujan', description: 'Lujan' });
  });

  it('REQ-NODES-2: empty listNodes() → 200 { nodes: [] }', async () => {
    const { app, iclass, resendUserId } = await buildApp();
    iclass.nodes = [];
    const res = await asUser(request(app).get('/api/scheduling/iclass/nodes'), resendUserId);
    expect(res.status).toBe(200);
    expect(res.body.nodes).toEqual([]);
  });

  it('REQ-NODES-4: super_admin short-circuit → 200', async () => {
    const { app, superAdminUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/scheduling/iclass/nodes'), superAdminUserId);
    expect(res.status).toBe(200);
  });

  it('REQ-NODES-1: route registered BEFORE /:id catch-all (iclass not treated as task id)', async () => {
    // If route order is wrong, Express would try getTask('iclass') → 404 TASK_NOT_FOUND
    // Correct: 200 with nodes (or 401/403 depending on auth — here we have valid user)
    const { app, resendUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/scheduling/iclass/nodes'), resendUserId);
    // Should NOT be a task response
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nodes');
    expect(res.body).not.toHaveProperty('stageId');
  });
});

// ─── POST /api/scheduling/:id/iclass/resend ───────────────────────────────

describe('POST /api/scheduling/:id/iclass/resend', () => {
  it('REQ-RESEND-9: without token → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/scheduling/some-task-id/iclass/resend')
      .send({ nodeCode: 'Mercedes' });
    expect(res.status).toBe(401);
  });

  it('REQ-RESEND-9, REQ-RBAC-RESEND-4: with valid token but no perm → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(
      request(app).post('/api/scheduling/some-task-id/iclass/resend').send({ nodeCode: 'Mercedes' }),
      noPermUserId,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('validation: body without nodeCode → 400', async () => {
    const { app, resendUserId } = await buildApp();
    const res = await asUser(
      request(app).post('/api/scheduling/some-task-id/iclass/resend').send({}),
      resendUserId,
    );
    expect(res.status).toBe(400);
  });

  it('validation: body with empty nodeCode → 400', async () => {
    const { app, resendUserId } = await buildApp();
    const res = await asUser(
      request(app).post('/api/scheduling/some-task-id/iclass/resend').send({ nodeCode: '' }),
      resendUserId,
    );
    expect(res.status).toBe(400);
  });

  it('REQ-RESEND-7: non-existent taskId → 404', async () => {
    const { app, resendUserId } = await buildApp();
    const res = await asUser(
      request(app).post('/api/scheduling/ghost-id/iclass/resend').send({ nodeCode: 'Mercedes' }),
      resendUserId,
    );
    expect(res.status).toBe(404);
  });

  it('REQ-RESEND-2: nodeCode not in listNodes → 422 ICLASS_NODE_NOT_FOUND', async () => {
    const { app, tasks, resendUserId } = await buildApp();
    tasks.seedTask({
      id: 'task-422',
      stageId: SEND_STAGE.id,
      projectId: DEFAULT_PROJECT_ID,
      customerName: 'Test',
      customerPhone: '123',
      customerCity: 'Mercedes',
      address: 'Calle 1',
      description: 'desc',
    });
    const res = await asUser(
      request(app).post('/api/scheduling/task-422/iclass/resend').send({ nodeCode: 'NONEXISTENT' }),
      resendUserId,
    );
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ICLASS_NODE_NOT_FOUND');
  });

  it('REQ-RESEND-4: happy path → 200, task advances to registered_in_iclass with iclassOrderCode', async () => {
    const { app, tasks, iclass, resendUserId } = await buildApp();
    tasks.seedTask({
      id: 'task-ok',
      stageId: SEND_STAGE.id,
      projectId: DEFAULT_PROJECT_ID,
      customerCode: 'CLI-OK',
      customerName: 'Juan',
      customerPhone: '341555',
      customerCity: 'Mercedes',
      address: 'Av. Test 1',
      description: 'Instalar fibra',
    });
    iclass.nextOrderCode = 'OS-RESEND-OK';

    const res = await asUser(
      request(app).post('/api/scheduling/task-ok/iclass/resend').send({ nodeCode: 'Mercedes' }),
      resendUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.iclassOrderCode).toBe('OS-RESEND-OK');
    expect(res.body.stageId).toBe(REGISTERED_STAGE.id);
  });

  it('REQ-RBAC-RESEND-4: super_admin short-circuit passes the guard', async () => {
    const { app, tasks, iclass, superAdminUserId } = await buildApp();
    tasks.seedTask({
      id: 'task-sa',
      stageId: SEND_STAGE.id,
      projectId: DEFAULT_PROJECT_ID,
      customerCode: 'CLI-SA',
      customerName: 'Super',
      customerPhone: '000',
      customerCity: 'Lujan',
      address: 'Calle SA 1',
      description: 'test',
    });
    iclass.nextOrderCode = 'OS-SA';

    const res = await asUser(
      request(app).post('/api/scheduling/task-sa/iclass/resend').send({ nodeCode: 'Lujan' }),
      superAdminUserId,
    );

    expect(res.status).toBe(200);
    expect(res.body.iclassOrderCode).toBe('OS-SA');
  });
});

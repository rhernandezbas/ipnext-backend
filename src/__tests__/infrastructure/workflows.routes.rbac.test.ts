/**
 * T-31: RBAC integration tests for workflows/stages routes.
 *
 * Scenarios (REQ-RBAC-1, REQ-RBAC-2):
 *   - No token → 401
 *   - Valid token, no scheduling.manage → 403 PERMISSION_DENIED
 *   - Valid token, scheduling.manage → 201/200
 *   - GET with scheduling.read → 200
 *   - GET without scheduling.read → 403
 *   - super_admin (no explicit perm) → short-circuit, not 401/403
 *
 * Pattern mirrors gestionRealSync.routes.test.ts.
 * Auth: cookie token IS the userId; EchoAuthProvider echoes it back as req.user.id.
 */

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemoryWorkflowRepository } from '@infrastructure/adapters/in-memory/InMemoryWorkflowRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryProjectCategoryRepository } from '@infrastructure/adapters/in-memory/InMemoryProjectCategoryRepository';
import { InMemoryProjectTypeRepository } from '@infrastructure/adapters/in-memory/InMemoryProjectTypeRepository';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createWorkflowsRouter } from '@infrastructure/http/routes/workflows.routes';

import { ListWorkflows } from '@application/use-cases/ListWorkflows';
import { GetWorkflow } from '@application/use-cases/GetWorkflow';
import { CreateWorkflow } from '@application/use-cases/CreateWorkflow';
import { UpdateWorkflow } from '@application/use-cases/UpdateWorkflow';
import { DeleteWorkflow } from '@application/use-cases/DeleteWorkflow';
import { AddStageToWorkflow } from '@application/use-cases/AddStageToWorkflow';
import { RemoveStageFromWorkflow } from '@application/use-cases/RemoveStageFromWorkflow';
import { ReorderStages } from '@application/use-cases/ReorderStages';
import { UpdateStageColor } from '@application/use-cases/UpdateStageColor';
import { ListProjectCategory } from '@application/use-cases/ListProjectCategory';
import { GetProjectCategory } from '@application/use-cases/GetProjectCategory';
import { CreateProjectCategory } from '@application/use-cases/CreateProjectCategory';
import { UpdateProjectCategory } from '@application/use-cases/UpdateProjectCategory';
import { DeleteProjectCategory } from '@application/use-cases/DeleteProjectCategory';
import { ListProjectType } from '@application/use-cases/ListProjectType';
import { GetProjectType } from '@application/use-cases/GetProjectType';
import { CreateProjectType } from '@application/use-cases/CreateProjectType';
import { UpdateProjectType } from '@application/use-cases/UpdateProjectType';
import { DeleteProjectType } from '@application/use-cases/DeleteProjectType';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

// Echo cookie token back as userId — same pattern as gestionRealSync.routes.test.ts
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
  wfRepo: InMemoryWorkflowRepository;
  manageUserId: string;   // scheduling.manage + scheduling.read
  readOnlyUserId: string; // scheduling.read only
  noPermUserId: string;   // no scheduling perms
  superAdminUserId: string;
}

async function buildApp(): Promise<Fixture> {
  const roleRepo     = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo     = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher       = new InMemoryPasswordHasher();
  const userRepo     = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  // Wire listRolesForUser + listPermissionsForUser through in-memory pivots
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
  const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });
  const managerRole    = await roleRepo.create({ code: 'wf_manager', label: 'WF Manager', isSystem: false });
  const readerRole     = await roleRepo.create({ code: 'wf_reader', label: 'WF Reader', isSystem: false });

  // Permissions
  const managePerm = await permRepo.seed({ moduleCode: 'scheduling', action: 'manage' });
  const readPerm   = await permRepo.seed({ moduleCode: 'scheduling', action: 'read' });

  await rolePermRepo.grant(managerRole.id, managePerm.id);
  await rolePermRepo.grant(managerRole.id, readPerm.id);
  await rolePermRepo.grant(readerRole.id, readPerm.id);

  // Users
  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const superAdminUser = await mkUser('super');
  await userRoleRepo.assign(superAdminUser.id, superAdminRole.id);

  const manageUser = await mkUser('manager');
  await userRoleRepo.assign(manageUser.id, managerRole.id);

  const readUser = await mkUser('reader');
  await userRoleRepo.assign(readUser.id, readerRole.id);

  const noPermUser = await mkUser('noperm');

  // Use cases
  const wfRepo    = new InMemoryWorkflowRepository();
  const stageRepo = new InMemoryStageRepository();
  const catRepo   = new InMemoryProjectCategoryRepository();
  const typeRepo  = new InMemoryProjectTypeRepository();

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/scheduling',
    createWorkflowsRouter(
      new EchoAuthProvider(),
      requirePerm,
      new ListWorkflows(wfRepo),
      new GetWorkflow(wfRepo),
      new CreateWorkflow(wfRepo),
      new UpdateWorkflow(wfRepo),
      new DeleteWorkflow(wfRepo, stageRepo),
      new AddStageToWorkflow(wfRepo, stageRepo),
      new RemoveStageFromWorkflow(stageRepo),
      new ReorderStages(wfRepo, stageRepo),
      new UpdateStageColor(stageRepo),
      new ListProjectCategory(catRepo),
      new GetProjectCategory(catRepo),
      new CreateProjectCategory(catRepo),
      new UpdateProjectCategory(catRepo),
      new DeleteProjectCategory(catRepo),
      new ListProjectType(typeRepo),
      new GetProjectType(typeRepo),
      new CreateProjectType(typeRepo),
      new UpdateProjectType(typeRepo),
      new DeleteProjectType(typeRepo),
    ),
  );
  app.use(errorHandler);

  return {
    app,
    wfRepo,
    manageUserId: manageUser.id,
    readOnlyUserId: readUser.id,
    noPermUserId: noPermUser.id,
    superAdminUserId: superAdminUser.id,
  };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ─── T-31: RBAC tests (REQ-RBAC-1, REQ-RBAC-2) ───────────────────────────────

describe('T-31: workflows.routes RBAC — POST /api/scheduling/workflows', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no token → 401', async () => {
    const res = await request(fx.app).post('/api/scheduling/workflows').send({ name: 'WF' });
    expect(res.status).toBe(401);
  });

  it('valid token, no scheduling.manage → 403 PERMISSION_DENIED', async () => {
    const res = await asUser(
      request(fx.app).post('/api/scheduling/workflows').send({ name: 'WF' }),
      fx.noPermUserId,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('valid token, scheduling.manage → 201', async () => {
    const res = await asUser(
      request(fx.app).post('/api/scheduling/workflows').send({ name: 'WF' }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
  });

  it('super_admin (no explicit perm) → 201 (short-circuit)', async () => {
    const res = await asUser(
      request(fx.app).post('/api/scheduling/workflows').send({ name: 'WF-SA' }),
      fx.superAdminUserId,
    );
    expect(res.status).toBe(201);
  });
});

describe('T-31: RBAC — DELETE /api/scheduling/workflows/:id', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no scheduling.manage → 403', async () => {
    // Create wf directly in repo so we have an id
    const wf = await fx.wfRepo.create({ name: 'ToDelete', description: null, stages: [] });
    const res = await asUser(
      request(fx.app).delete(`/api/scheduling/workflows/${wf.id}`),
      fx.noPermUserId,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('scheduling.manage → 204', async () => {
    const wf = await fx.wfRepo.create({ name: 'ToDelete2', description: null, stages: [] });
    const res = await asUser(
      request(fx.app).delete(`/api/scheduling/workflows/${wf.id}`),
      fx.manageUserId,
    );
    expect(res.status).toBe(204);
  });
});

describe('T-31: RBAC — POST /api/scheduling/workflows/:id/stages', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no scheduling.manage → 403', async () => {
    const wf = await fx.wfRepo.create({ name: 'WF', description: null, stages: [] });
    const res = await asUser(
      request(fx.app)
        .post(`/api/scheduling/workflows/${wf.id}/stages`)
        .send({ name: 'S', category: 'nuevo', order: 0 }),
      fx.noPermUserId,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('scheduling.manage → 201', async () => {
    const wf = await fx.wfRepo.create({ name: 'WF2', description: null, stages: [] });
    const res = await asUser(
      request(fx.app)
        .post(`/api/scheduling/workflows/${wf.id}/stages`)
        .send({ name: 'S', category: 'nuevo', order: 0 }),
      fx.manageUserId,
    );
    expect(res.status).toBe(201);
  });
});

describe('T-31: RBAC — GET /api/scheduling/workflows (scheduling.read)', () => {
  let fx: Fixture;
  beforeEach(async () => { fx = await buildApp(); });

  it('no scheduling.read → 403 PERMISSION_DENIED', async () => {
    const res = await asUser(
      request(fx.app).get('/api/scheduling/workflows'),
      fx.noPermUserId,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('scheduling.read → 200', async () => {
    const res = await asUser(
      request(fx.app).get('/api/scheduling/workflows'),
      fx.readOnlyUserId,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('scheduling.manage (which includes read role) → 200', async () => {
    const res = await asUser(
      request(fx.app).get('/api/scheduling/workflows'),
      fx.manageUserId,
    );
    expect(res.status).toBe(200);
  });

  it('super_admin → 200 (short-circuit)', async () => {
    const res = await asUser(
      request(fx.app).get('/api/scheduling/workflows'),
      fx.superAdminUserId,
    );
    expect(res.status).toBe(200);
  });
});

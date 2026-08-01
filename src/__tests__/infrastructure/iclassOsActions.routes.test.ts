/**
 * Integration tests for IClass OS Action routes:
 *   POST /api/scheduling/:id/iclass/close     (R1-R7)
 *   POST /api/scheduling/:id/iclass/assign-team (R8-R9)
 *
 * Also covers R12: errorHandler maps the 5 new error codes to correct HTTP status.
 *
 * TDD: tests written first, routes implemented after.
 * Auth: EchoAuthProvider (cookie token = userId) + InMemory RBAC.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassClient } from '@infrastructure/adapters/in-memory/InMemoryIClassClient';
import { InMemoryIClassResultCodeRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemoryIClassTeamRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createSchedulingRouter } from '@infrastructure/http/routes/scheduling.routes';
import { CloseIClassServiceOrder } from '@application/use-cases/CloseIClassServiceOrder';
import { AssignIClassTeam } from '@application/use-cases/AssignIClassTeam';
import { ListTasks } from '@application/use-cases/ListTasks';
import { GetTask } from '@application/use-cases/GetTask';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { MoveTaskToStage } from '@application/use-cases/MoveTaskToStage';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import { EntityLookup } from '@domain/ports/EntityLookup';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

// ─── Stub lookups ──────────────────────────────────────────────────────────
class AnyLookup implements EntityLookup {
  async findById(id: string) { return { id, isNetworkProject: false }; }
}
const anyLookup = new AnyLookup();

// ─── EchoAuthProvider ──────────────────────────────────────────────────────
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

const TASK_ID = 'task-action-1';
const ORDER_CODE = 'OS-ROUTE-1';
const RESULT_CODE = 'RESOLVIDO';
const TEAM_LOGIN = 'equipe-01';

async function buildRbac() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher = new InMemoryPasswordHasher();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

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

  const closerRole = await roleRepo.create({ code: 'closer_role', label: 'Closer', isSystem: false });
  const assignerRole = await roleRepo.create({ code: 'assigner_role', label: 'Assigner', isSystem: false });

  const closePerm = await permRepo.seed({ moduleCode: 'scheduling', action: 'iclass_close' });
  const assignPerm = await permRepo.seed({ moduleCode: 'scheduling', action: 'iclass_assign' });

  await rolePermRepo.grant(closerRole.id, closePerm.id);
  await rolePermRepo.grant(assignerRole.id, assignPerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const closerUser = await mkUser('closer');
  await userRoleRepo.assign(closerUser.id, closerRole.id);

  const assignerUser = await mkUser('assigner');
  await userRoleRepo.assign(assignerUser.id, assignerRole.id);

  const noPermUser = await mkUser('noperm');

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);

  return {
    requirePerm,
    closerUserId: closerUser.id,
    assignerUserId: assignerUser.id,
    noPermUserId: noPermUser.id,
  };
}

interface AppFixture {
  app: express.Express;
  tasks: InMemorySchedulingRepository;
  iclass: InMemoryIClassClient;
  flags: InMemoryFeatureFlagRepository;
  closerUserId: string;
  assignerUserId: string;
  noPermUserId: string;
}

async function buildApp(): Promise<AppFixture> {
  const { requirePerm, closerUserId, assignerUserId, noPermUserId } = await buildRbac();

  const stageRepo = new InMemoryStageRepository();
  const tasks = new InMemorySchedulingRepository(stageRepo);
  const iclass = new InMemoryIClassClient();
  const resultCodeRepo = new InMemoryIClassResultCodeRepository();
  const teamRepo = new InMemoryIClassTeamRepository();
  const flags = new InMemoryFeatureFlagRepository();

  // Seed flags ON
  flags.seed('iclass-close-action', true);
  flags.seed('iclass-assign-action', true);

  // Seed result code
  await resultCodeRepo.upsert({ code: RESULT_CODE, type: 'Sucesso', soTypeId: null });

  // Seed team
  await teamRepo.upsertByLogin({ login: TEAM_LOGIN, name: 'Equipe Alpha', thirdPartyCode: null, active: true, selectable: true });

  // Seed task — startDate/endDate required for the assign-team flow (#130: schedule window).
  tasks.seedTask({
    id: TASK_ID,
    iclassOrderCode: ORDER_CODE,
    generalStatus: 'open',
    title: 'Test action task',
    startDate: '2026-06-18T13:00:00.000Z',
    endDate: '2026-06-18T14:00:00.000Z',
  });

  // Seed OS snapshot (non-terminal)
  iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-1', iclassCodigo: ORDER_CODE, statusCode: '1', statusDescription: 'Aberta' });

  const authProvider = new EchoAuthProvider();
  const closeUC = new CloseIClassServiceOrder(tasks, iclass, resultCodeRepo, flags);
  const assignUC = new AssignIClassTeam(tasks, iclass, teamRepo, flags);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/scheduling', createSchedulingRouter(
    new ListTasks(tasks),
    new GetTask(tasks),
    new CreateTask(tasks, anyLookup, anyLookup, anyLookup, anyLookup, anyLookup),
    new UpdateTask(tasks, anyLookup, anyLookup, anyLookup, anyLookup, anyLookup),
    new DeleteTask(tasks),
    new MoveTaskToStage(tasks, stageRepo),
    authProvider,
    undefined, // sessionRepo
    stageRepo,
    undefined, // checklist
    undefined, // setTaskInventoryReview
    undefined, // bulkMoveTasksToStage
    undefined, // resendDeps
    undefined, // getTaskActivity
    undefined, // requireInventoryWrite
    undefined, // retireContractEquipment
    undefined, // setTaskGeneralStatus
    undefined, // requireSchedulingWrite
    undefined, // archiveTask
    undefined, // requireHardDelete
    { closeIClassServiceOrder: closeUC, assignIClassTeam: assignUC, requirePerm }, // iclassActionDeps
  ));
  app.use(errorHandler);

  return { app, tasks, iclass, flags, closerUserId, assignerUserId, noPermUserId };
}

function asUser(req: request.Test, userId: string): request.Test {
  return req.set('Cookie', `auth_token=${userId}`);
}

// ─── R1: POST close sin permiso → 403 ─────────────────────────────────────

describe('POST /api/scheduling/:id/iclass/close', () => {
  it('R1: no permission → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/close`), noPermUserId)
      .send({ resultCode: RESULT_CODE, commentary: 'test' });
    expect(res.status).toBe(403);
  });

  // R2: body inválido → 400
  it('R2: invalid body (missing commentary) → 400 VALIDATION_ERROR', async () => {
    const { app, closerUserId } = await buildApp();
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/close`), closerUserId)
      .send({ resultCode: RESULT_CODE }); // missing commentary
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // R3: happy path → 200 task DTO
  it('R3: happy path → 200 with task DTO (generalStatus=closed)', async () => {
    const { app, closerUserId } = await buildApp();
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/close`), closerUserId)
      .send({ resultCode: RESULT_CODE, commentary: 'Cierre desde Prominense' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(TASK_ID);
    expect(res.body.generalStatus).toBe('closed');
  });

  // R4: OS terminal → 409 ICLASS_ALREADY_CLOSED
  it('R4: OS already closed in IClass → 409 ICLASS_ALREADY_CLOSED', async () => {
    const { app, closerUserId, iclass } = await buildApp();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-1', iclassCodigo: ORDER_CODE, statusCode: '7', statusDescription: 'Fechada' });
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/close`), closerUserId)
      .send({ resultCode: RESULT_CODE, commentary: 'test' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ICLASS_ALREADY_CLOSED');
  });

  // R5: IClass rejects → 422 + reason visible
  it('R5: IClass rejects → 422 with reason in body', async () => {
    const { app, closerUserId, iclass } = await buildApp();
    iclass.setCloseMode('rejected');
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/close`), closerUserId)
      .send({ resultCode: RESULT_CODE, commentary: 'test' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ICLASS_REJECTED');
    expect(res.body).toHaveProperty('reason');
    expect(typeof res.body.reason).toBe('string');
  });

  // R6: IClass unavailable → 502
  it('R6: IClass unavailable → 502', async () => {
    const { app, closerUserId, iclass } = await buildApp();
    iclass.setCloseMode('unavailable');
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/close`), closerUserId)
      .send({ resultCode: RESULT_CODE, commentary: 'test' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ICLASS_UNAVAILABLE');
  });

  // R7: flag OFF → 409 ICLASS_ACTION_DISABLED
  it('R7: flag OFF → 409 ICLASS_ACTION_DISABLED', async () => {
    const { app, closerUserId, flags } = await buildApp();
    flags.seed('iclass-close-action', false);
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/close`), closerUserId)
      .send({ resultCode: RESULT_CODE, commentary: 'test' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ICLASS_ACTION_DISABLED');
  });
});

// ─── R8-R9: POST assign-team ───────────────────────────────────────────────

describe('POST /api/scheduling/:id/iclass/assign-team', () => {
  it('R8: no permission → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/assign-team`), noPermUserId)
      .send({ teamLogin: TEAM_LOGIN });
    expect(res.status).toBe(403);
  });

  it('R9: happy path → 200 with task DTO', async () => {
    const { app, assignerUserId } = await buildApp();
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/assign-team`), assignerUserId)
      .send({ teamLogin: TEAM_LOGIN });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(TASK_ID);
  });
});

// ─── R12: errorHandler maps new codes ─────────────────────────────────────

describe('errorHandler: maps new IClass OS action codes', () => {
  it('R12: ICLASS_ACTION_DISABLED → 409', async () => {
    const { app, closerUserId, flags } = await buildApp();
    flags.seed('iclass-close-action', false);
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/close`), closerUserId)
      .send({ resultCode: RESULT_CODE, commentary: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ICLASS_ACTION_DISABLED');
  });

  it('R12: ICLASS_ALREADY_CLOSED → 409', async () => {
    const { app, closerUserId, iclass } = await buildApp();
    iclass.setServiceOrderSnapshot(ORDER_CODE, { iclassId: 'iclass-1', iclassCodigo: ORDER_CODE, statusCode: '7', statusDescription: 'Fechada' });
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/close`), closerUserId)
      .send({ resultCode: RESULT_CODE, commentary: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ICLASS_ALREADY_CLOSED');
  });

  it('R12: ICLASS_NO_SERVICE_ORDER → 422 (when getServiceOrder returns null)', async () => {
    const { app, closerUserId, iclass } = await buildApp();
    iclass.setServiceOrderSnapshot(ORDER_CODE, null);
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/close`), closerUserId)
      .send({ resultCode: RESULT_CODE, commentary: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ICLASS_NO_SERVICE_ORDER');
  });

  it('R12: ICLASS_UNAVAILABLE → 502', async () => {
    const { app, closerUserId, iclass } = await buildApp();
    iclass.setCloseMode('unavailable');
    const res = await asUser(request(app).post(`/api/scheduling/${TASK_ID}/iclass/close`), closerUserId)
      .send({ resultCode: RESULT_CODE, commentary: 'x' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('ICLASS_UNAVAILABLE');
  });
});

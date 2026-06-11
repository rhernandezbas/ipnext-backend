/**
 * Regression test: scheduling router + workflows router both mount under
 * /api/scheduling. The /:id catch-all in scheduling would otherwise swallow
 * /workflows, /project-categories, /project-types if mounted in wrong order.
 *
 * This bug shipped to production once because workflows.routes.test.ts mounts
 * the workflows router in isolation and never exercised the composition.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { createWorkflowsRouter } from '../../infrastructure/http/routes/workflows.routes';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryTaskTemplateRepository } from '../../infrastructure/adapters/in-memory/InMemoryTaskTemplateRepository';
import { InMemoryWorkflowRepository } from '../../infrastructure/adapters/in-memory/InMemoryWorkflowRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryProjectCategoryRepository } from '../../infrastructure/adapters/in-memory/InMemoryProjectCategoryRepository';
import { InMemoryProjectTypeRepository } from '../../infrastructure/adapters/in-memory/InMemoryProjectTypeRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { AddChecklistItem } from '../../application/use-cases/AddChecklistItem';
import { ToggleChecklistItem } from '../../application/use-cases/ToggleChecklistItem';
import { UpdateChecklistItem } from '../../application/use-cases/UpdateChecklistItem';
import { RemoveChecklistItem } from '../../application/use-cases/RemoveChecklistItem';
import { ReorderChecklistItems } from '../../application/use-cases/ReorderChecklistItems';
import { AssignTemplateToTask } from '../../application/use-cases/AssignTemplateToTask';
import { ClearTaskChecklist } from '../../application/use-cases/ClearTaskChecklist';
import { SetTaskGeneralStatus } from '../../application/use-cases/SetTaskGeneralStatus';
import { ListWorkflows } from '../../application/use-cases/ListWorkflows';
import { GetWorkflow } from '../../application/use-cases/GetWorkflow';
import { CreateWorkflow } from '../../application/use-cases/CreateWorkflow';
import { UpdateWorkflow } from '../../application/use-cases/UpdateWorkflow';
import { DeleteWorkflow } from '../../application/use-cases/DeleteWorkflow';
import { AddStageToWorkflow } from '../../application/use-cases/AddStageToWorkflow';
import { RemoveStageFromWorkflow } from '../../application/use-cases/RemoveStageFromWorkflow';
import { ReorderStages } from '../../application/use-cases/ReorderStages';
import { UpdateStageColor } from '../../application/use-cases/UpdateStageColor';
import { UpdateStage } from '../../application/use-cases/UpdateStage';
import { ListProjectCategory } from '../../application/use-cases/ListProjectCategory';
import { GetProjectCategory } from '../../application/use-cases/GetProjectCategory';
import { CreateProjectCategory } from '../../application/use-cases/CreateProjectCategory';
import { UpdateProjectCategory } from '../../application/use-cases/UpdateProjectCategory';
import { DeleteProjectCategory } from '../../application/use-cases/DeleteProjectCategory';
import { ListProjectType } from '../../application/use-cases/ListProjectType';
import { GetProjectType } from '../../application/use-cases/GetProjectType';
import { CreateProjectType } from '../../application/use-cases/CreateProjectType';
import { UpdateProjectType } from '../../application/use-cases/UpdateProjectType';
import { DeleteProjectType } from '../../application/use-cases/DeleteProjectType';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { EntityLookup } from '../../domain/ports/EntityLookup';
import type { RbacModuleCode, PermissionAction } from '../../domain/entities/rbac';

// Permissive requirePerm — always calls next() (RBAC not under test here)
const allowAll = (_m: RbacModuleCode, _a: PermissionAction) =>
  (_req: Request, _res: Response, next: NextFunction) => next();

class StubLookup implements EntityLookup {
  async findById(_id: string) { return null; }
}
const emptyLookup = new StubLookup();

class FakeAuthProvider implements AuthProvider {
  async login() {
    return { user: { id: 'a-1', username: 't', email: 't@t.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'a-1', username: 't', email: 't@t.com', role: 'admin' };
  }
}

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const templateRepo = new InMemoryTaskTemplateRepository();
  const schedRepo = new InMemorySchedulingRepository(undefined, templateRepo);
  const wfRepo = new InMemoryWorkflowRepository();
  const stageRepo = new InMemoryStageRepository();
  const catRepo = new InMemoryProjectCategoryRepository();
  const typeRepo = new InMemoryProjectTypeRepository();
  const authProvider = new FakeAuthProvider();

  // Same order as src/infrastructure/http/app.ts:
  // workflows MUST be mounted BEFORE scheduling.
  app.use('/api/scheduling', createWorkflowsRouter(
    authProvider,
    allowAll,
    new ListWorkflows(wfRepo),
    new GetWorkflow(wfRepo),
    new CreateWorkflow(wfRepo),
    new UpdateWorkflow(wfRepo),
    new DeleteWorkflow(wfRepo, stageRepo),
    new AddStageToWorkflow(wfRepo, stageRepo),
    new RemoveStageFromWorkflow(stageRepo),
    new ReorderStages(wfRepo, stageRepo),
    new UpdateStageColor(stageRepo),
    new UpdateStage(stageRepo),
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
  ));
  app.use('/api/scheduling', createSchedulingRouter(
    new ListTasks(schedRepo),
    new GetTask(schedRepo),
    new CreateTask(schedRepo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup),
    new UpdateTask(schedRepo, emptyLookup, emptyLookup, emptyLookup, emptyLookup, emptyLookup),
    new DeleteTask(schedRepo),
    new MoveTaskToStage(schedRepo, stageRepo),
    authProvider,
    stageRepo,
    {
      addChecklistItem: new AddChecklistItem(schedRepo),
      toggleChecklistItem: new ToggleChecklistItem(schedRepo),
      updateChecklistItem: new UpdateChecklistItem(schedRepo),
      removeChecklistItem: new RemoveChecklistItem(schedRepo),
      reorderChecklistItems: new ReorderChecklistItems(schedRepo),
      assignTemplateToTask: new AssignTemplateToTask(schedRepo, templateRepo),
      clearTaskChecklist: new ClearTaskChecklist(schedRepo),
    },
    undefined, // setTaskInventoryReview
    undefined, // bulkMoveTasksToStage
    undefined, // resendDeps
    undefined, // getTaskActivity
    undefined, // requireInventoryWrite
    undefined, // retireContractEquipment
    new SetTaskGeneralStatus(schedRepo), // #41 — POST /:id/status reachable
    undefined, // requireSchedulingWrite (pass-through)
  ));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('Composition: scheduling + workflows routers on same prefix', () => {
  const cookie = 'auth_token=fake';

  it('GET /api/scheduling/workflows returns workflow list (NOT 404 TASK_NOT_FOUND)', async () => {
    const res = await request(buildApp())
      .get('/api/scheduling/workflows')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).not.toEqual({ error: expect.any(String), code: 'TASK_NOT_FOUND' });
  });

  it('GET /api/scheduling/project-categories returns category list (NOT 404 TASK_NOT_FOUND)', async () => {
    const res = await request(buildApp())
      .get('/api/scheduling/project-categories')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/scheduling/project-types returns type list (NOT 404 TASK_NOT_FOUND)', async () => {
    const res = await request(buildApp())
      .get('/api/scheduling/project-types')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/scheduling still returns task list (scheduling router not shadowed)', async () => {
    const res = await request(buildApp())
      .get('/api/scheduling')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/scheduling/<random-uuid> still returns 404 TASK_NOT_FOUND', async () => {
    const res = await request(buildApp())
      .get('/api/scheduling/00000000-0000-4000-a000-000000000999')
      .set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  it('POST /api/scheduling/:id/checklist/assign-template does NOT return TASK_NOT_FOUND (returns TEMPLATE_NOT_FOUND)', async () => {
    // This verifies the sub-route is not shadowed by the /:id catch-all.
    // Using an unknown templateId so we get TEMPLATE_NOT_FOUND, not TASK_NOT_FOUND.
    const res = await request(buildApp())
      .post('/api/scheduling/00000000-0000-4000-a000-000000000001/checklist/assign-template')
      .set('Cookie', cookie)
      .send({ templateId: 'nonexistent-tpl' });
    // The route handler is reached (not the /:id catch-all), so code must NOT be TASK_NOT_FOUND
    expect(res.body.code).not.toBe('TASK_NOT_FOUND');
    // Should be TEMPLATE_NOT_FOUND (the sub-route ran and template lookup failed)
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('PUT /api/scheduling/:id/checklist/order does NOT return TASK_NOT_FOUND', async () => {
    // This verifies /:id PUT handler doesn't shadow the sub-route.
    const res = await request(buildApp())
      .put('/api/scheduling/00000000-0000-4000-a000-000000000001/checklist/order')
      .set('Cookie', cookie)
      .send({ orderedIds: [] });
    expect(res.body.code).not.toBe('TASK_NOT_FOUND');
    // Should return 200 (empty list, no-op) or 400 validation error — NOT TASK_NOT_FOUND
    expect([200, 400]).toContain(res.status);
  });

  // W-3 from verify report — DELETE sub-routes also share the /:id prefix and
  // must not fall through to the scheduling /:id DELETE catch-all.
  it('DELETE /api/scheduling/:id/checklist does NOT return TASK_NOT_FOUND', async () => {
    const res = await request(buildApp())
      .delete('/api/scheduling/00000000-0000-4000-a000-000000000001/checklist')
      .set('Cookie', cookie);
    expect(res.body.code).not.toBe('TASK_NOT_FOUND');
    // Should return 204 (clear, no-op when no items) or 404 with a checklist-specific code
    expect([204, 404]).toContain(res.status);
  });

  it('DELETE /api/scheduling/checklist/:itemId does NOT return TASK_NOT_FOUND', async () => {
    // This URL doesn't even contain a task /:id segment, but we still assert the
    // router resolves to the correct handler (not a 404 from the scheduling /:id).
    const res = await request(buildApp())
      .delete('/api/scheduling/checklist/00000000-0000-4000-a000-000000000001')
      .set('Cookie', cookie);
    expect(res.body.code).not.toBe('TASK_NOT_FOUND');
    // Item doesn't exist → 404 CHECKLIST_ITEM_NOT_FOUND (or similar) is the expected response
    expect([204, 404]).toContain(res.status);
  });

  // Phase 3: PATCH /:id/status is removed — must 404 and NOT shadow GET /:id
  it('PATCH /api/scheduling/:id/status returns 404 (route removed)', async () => {
    const res = await request(buildApp())
      .patch('/api/scheduling/1/status')
      .set('Cookie', cookie)
      .send({ status: 'completed' });
    expect(res.status).toBe(404);
  });

  // #41 — POST /:id/status is reachable (not shadowed by GET /:id catch-all).
  it('POST /api/scheduling/:id/status reaches the handler (200, not shadowed)', async () => {
    const res = await request(buildApp())
      .post('/api/scheduling/1/status')
      .set('Cookie', cookie)
      .send({ status: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('1');
    expect(res.body.generalStatus).toBe('closed');
    expect(res.body.isClosed).toBe(true);
  });

  // #41 — PATCH /:id/status still 404 even though POST /:id/status now exists.
  it('PATCH /api/scheduling/:id/status still 404 with POST /:id/status registered', async () => {
    const res = await request(buildApp())
      .patch('/api/scheduling/1/status')
      .set('Cookie', cookie)
      .send({ status: 'closed' });
    expect(res.status).toBe(404);
  });

  it('GET /api/scheduling/:id still works after status route removed', async () => {
    // Seeded task id=1 must still be reachable via GET /:id
    const res = await request(buildApp())
      .get('/api/scheduling/1')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('1');
  });
});

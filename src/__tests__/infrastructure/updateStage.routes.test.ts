/**
 * PATCH /api/scheduling/workflows/:id/stages/:stageId
 * Renames a stage and/or changes its category.
 * code is IMMUTABLE — never exposed to mutation.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createWorkflowsRouter } from '../../infrastructure/http/routes/workflows.routes';
import { InMemoryWorkflowRepository } from '../../infrastructure/adapters/in-memory/InMemoryWorkflowRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryProjectCategoryRepository } from '../../infrastructure/adapters/in-memory/InMemoryProjectCategoryRepository';
import { InMemoryProjectTypeRepository } from '../../infrastructure/adapters/in-memory/InMemoryProjectTypeRepository';
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
import type { RbacModuleCode, PermissionAction } from '../../domain/entities/rbac';

const allowAll = (_m: RbacModuleCode, _a: PermissionAction) =>
  (_req: Request, _res: Response, next: NextFunction) => next();

const denyAll = (_m: RbacModuleCode, _a: PermissionAction) =>
  (_req: Request, res: Response, _next: NextFunction) => res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });

class FakeAuthProvider implements AuthProvider {
  async login() {
    return { user: { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' };
  }
}

interface AppBundle {
  app: express.Express;
  wfRepo: InMemoryWorkflowRepository;
  stageRepo: InMemoryStageRepository;
  updateStage: UpdateStage;
}

function buildApp(requirePerm = allowAll): AppBundle {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const wfRepo = new InMemoryWorkflowRepository();
  const stageRepo = new InMemoryStageRepository();
  const catRepo = new InMemoryProjectCategoryRepository();
  const typeRepo = new InMemoryProjectTypeRepository();
  const updateStage = new UpdateStage(stageRepo);

  app.use('/api/scheduling', createWorkflowsRouter(
    new FakeAuthProvider(),
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
    updateStage,
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

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, wfRepo, stageRepo, updateStage };
}

async function createWorkflowWithStage(app: express.Express) {
  const wfRes = await request(app)
    .post('/api/scheduling/workflows')
    .set('Cookie', 'auth_token=fake')
    .send({ name: 'Test WF' });
  expect(wfRes.status).toBe(201);

  const stageRes = await request(app)
    .post(`/api/scheduling/workflows/${wfRes.body.id}/stages`)
    .set('Cookie', 'auth_token=fake')
    .send({ name: 'Stage Original', category: 'nuevo', order: 0 });
  expect(stageRes.status).toBe(201);

  return { workflowId: wfRes.body.id as string, stage: stageRes.body as { id: string; name: string; category: string; code: string } };
}

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('PATCH /api/scheduling/workflows/:id/stages/:stageId', () => {
  it('200: renames the stage', async () => {
    const { app } = buildApp();
    const { workflowId, stage } = await createWorkflowWithStage(app);

    const res = await request(app)
      .patch(`/api/scheduling/workflows/${workflowId}/stages/${stage.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Nuevo Nombre' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nuevo Nombre');
    expect(res.body.id).toBe(stage.id);
  });

  it('200: changes the category', async () => {
    const { app } = buildApp();
    const { workflowId, stage } = await createWorkflowWithStage(app);

    const res = await request(app)
      .patch(`/api/scheduling/workflows/${workflowId}/stages/${stage.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ category: 'hecho' });

    expect(res.status).toBe(200);
    expect(res.body.category).toBe('hecho');
  });

  it('200: changes both name and category', async () => {
    const { app } = buildApp();
    const { workflowId, stage } = await createWorkflowWithStage(app);

    const res = await request(app)
      .patch(`/api/scheduling/workflows/${workflowId}/stages/${stage.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'En Proceso', category: 'enProgreso' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('En Proceso');
    expect(res.body.category).toBe('enProgreso');
  });

  it('200: code is NEVER mutated — stays original even if payload tries to send it', async () => {
    const { app } = buildApp();
    const { workflowId, stage } = await createWorkflowWithStage(app);
    const originalCode = stage.code;

    const res = await request(app)
      .patch(`/api/scheduling/workflows/${workflowId}/stages/${stage.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Changed', code: 'hacked_code' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(originalCode);
    expect(res.body.code).not.toBe('hacked_code');
  });

  // ─── Error cases ───────────────────────────────────────────────────────────

  it('404: stage not found → STAGE_NOT_FOUND', async () => {
    const { app } = buildApp();
    const wfRes = await request(app)
      .post('/api/scheduling/workflows')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'WF-404' });

    const res = await request(app)
      .patch(`/api/scheduling/workflows/${wfRes.body.id}/stages/non-existent-id`)
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Whatever' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('STAGE_NOT_FOUND');
  });

  it('409: duplicate name in same workflow → STAGE_NAME_CONFLICT', async () => {
    const { app } = buildApp();
    const { workflowId, stage } = await createWorkflowWithStage(app);

    // Crear un segundo stage
    await request(app)
      .post(`/api/scheduling/workflows/${workflowId}/stages`)
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Stage Dos', category: 'hecho', order: 1 });

    // Intentar renombrar el primero al nombre del segundo
    const res = await request(app)
      .patch(`/api/scheduling/workflows/${workflowId}/stages/${stage.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Stage Dos' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STAGE_NAME_CONFLICT');
  });

  it('400: invalid category value → VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const { workflowId, stage } = await createWorkflowWithStage(app);

    const res = await request(app)
      .patch(`/api/scheduling/workflows/${workflowId}/stages/${stage.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ category: 'INVALID_CAT' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400: empty body (no name, no category) → VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const { workflowId, stage } = await createWorkflowWithStage(app);

    const res = await request(app)
      .patch(`/api/scheduling/workflows/${workflowId}/stages/${stage.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // ─── Auth / RBAC ───────────────────────────────────────────────────────────

  it('401: no token → UNAUTHORIZED', async () => {
    const { app } = buildApp();
    const { workflowId, stage } = await createWorkflowWithStage(app);

    const res = await request(app)
      .patch(`/api/scheduling/workflows/${workflowId}/stages/${stage.id}`)
      .send({ name: 'X' });

    expect(res.status).toBe(401);
  });

  it('403: no scheduling.manage permission → PERMISSION_DENIED', async () => {
    const { app } = buildApp(denyAll);
    // buildApp con denyAll, creamos workflow+stage directo en repos
    const { wfRepo, stageRepo } = buildApp(denyAll);
    const wf = await wfRepo.create({ name: 'WF-DENY', description: null, stages: [] });
    const stage = await stageRepo.add(wf.id, { name: 'S', code: 's', category: 'nuevo', order: 0 });

    const res = await request(app)
      .patch(`/api/scheduling/workflows/${wf.id}/stages/${stage.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'X' });

    expect(res.status).toBe(403);
  });
});

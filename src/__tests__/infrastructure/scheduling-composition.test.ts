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
import { InMemoryWorkflowRepository } from '../../infrastructure/adapters/in-memory/InMemoryWorkflowRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryProjectCategoryRepository } from '../../infrastructure/adapters/in-memory/InMemoryProjectCategoryRepository';
import { InMemoryProjectTypeRepository } from '../../infrastructure/adapters/in-memory/InMemoryProjectTypeRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { UpdateTaskStatus } from '../../application/use-cases/UpdateTaskStatus';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { ListWorkflows } from '../../application/use-cases/ListWorkflows';
import { GetWorkflow } from '../../application/use-cases/GetWorkflow';
import { CreateWorkflow } from '../../application/use-cases/CreateWorkflow';
import { UpdateWorkflow } from '../../application/use-cases/UpdateWorkflow';
import { DeleteWorkflow } from '../../application/use-cases/DeleteWorkflow';
import { AddStageToWorkflow } from '../../application/use-cases/AddStageToWorkflow';
import { RemoveStageFromWorkflow } from '../../application/use-cases/RemoveStageFromWorkflow';
import { ReorderStages } from '../../application/use-cases/ReorderStages';
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

  const schedRepo = new InMemorySchedulingRepository();
  const wfRepo = new InMemoryWorkflowRepository();
  const stageRepo = new InMemoryStageRepository();
  const catRepo = new InMemoryProjectCategoryRepository();
  const typeRepo = new InMemoryProjectTypeRepository();
  const authProvider = new FakeAuthProvider();

  // Same order as src/infrastructure/http/app.ts:
  // workflows MUST be mounted BEFORE scheduling.
  app.use('/api/scheduling', createWorkflowsRouter(
    authProvider,
    new ListWorkflows(wfRepo),
    new GetWorkflow(wfRepo),
    new CreateWorkflow(wfRepo),
    new UpdateWorkflow(wfRepo),
    new DeleteWorkflow(wfRepo, stageRepo),
    new AddStageToWorkflow(wfRepo, stageRepo),
    new RemoveStageFromWorkflow(stageRepo),
    new ReorderStages(wfRepo, stageRepo),
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
    new CreateTask(schedRepo),
    new UpdateTask(schedRepo),
    new DeleteTask(schedRepo),
    new UpdateTaskStatus(schedRepo, stageRepo),
    new MoveTaskToStage(schedRepo, stageRepo),
    authProvider,
    stageRepo,
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
});

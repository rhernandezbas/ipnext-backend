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

// Permissive requirePerm for non-RBAC tests — always calls next()
const allowAll = (_m: RbacModuleCode, _a: PermissionAction) =>
  (_req: Request, _res: Response, next: NextFunction) => next();

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

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const wfRepo = new InMemoryWorkflowRepository();
  const stageRepo = new InMemoryStageRepository();
  const catRepo = new InMemoryProjectCategoryRepository();
  const typeRepo = new InMemoryProjectTypeRepository();
  const authProvider = new FakeAuthProvider();

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

  return app;
}

// ─── REQ-WF-AUTH-1/2/3: Unauthenticated requests rejected ────────────────────

describe('Auth: workflow routes reject missing cookie', () => {
  const routes = [
    ['GET',    '/api/scheduling/workflows'],
    ['GET',    '/api/scheduling/workflows/some-id'],
    ['POST',   '/api/scheduling/workflows'],
    ['PUT',    '/api/scheduling/workflows/some-id'],
    ['DELETE', '/api/scheduling/workflows/some-id'],
    ['GET',    '/api/scheduling/project-categories'],
    ['POST',   '/api/scheduling/project-categories'],
    ['GET',    '/api/scheduling/project-types'],
    ['POST',   '/api/scheduling/project-types'],
  ] as const;

  routes.forEach(([method, path]) => {
    it(`${method} ${path} → 401 UNAUTHORIZED`, async () => {
      const app = buildApp();
      const res = await (request(app) as any)[method.toLowerCase()](path);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });
  });
});

// ─── REQ-WF-LIST-1: GET /workflows ───────────────────────────────────────────

describe('GET /api/scheduling/workflows', () => {
  it('returns empty array initially', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/scheduling/workflows')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ─── REQ-WF-GET-1/2: GET /workflows/:id ──────────────────────────────────────

describe('GET /api/scheduling/workflows/:id', () => {
  it('REQ-WF-GET-1: returns 200 with workflow when id exists', async () => {
    const wfRepo = new InMemoryWorkflowRepository();
    const created = await wfRepo.create({ name: 'Test', description: null, stages: [] });

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    const stageRepo = new InMemoryStageRepository();
    const catRepo = new InMemoryProjectCategoryRepository();
    const typeRepo = new InMemoryProjectTypeRepository();
    app.use('/api/scheduling', createWorkflowsRouter(
      new FakeAuthProvider(),
      allowAll,
      new ListWorkflows(wfRepo), new GetWorkflow(wfRepo),
      new CreateWorkflow(wfRepo), new UpdateWorkflow(wfRepo),
      new DeleteWorkflow(wfRepo, stageRepo),
      new AddStageToWorkflow(wfRepo, stageRepo),
      new RemoveStageFromWorkflow(stageRepo),
      new ReorderStages(wfRepo, stageRepo),
      new UpdateStageColor(stageRepo),
      new ListProjectCategory(catRepo), new GetProjectCategory(catRepo),
      new CreateProjectCategory(catRepo), new UpdateProjectCategory(catRepo),
      new DeleteProjectCategory(catRepo),
      new ListProjectType(typeRepo), new GetProjectType(typeRepo),
      new CreateProjectType(typeRepo), new UpdateProjectType(typeRepo),
      new DeleteProjectType(typeRepo),
    ));

    const res = await request(app)
      .get(`/api/scheduling/workflows/${created.id}`)
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Test');
  });

  it('REQ-WF-GET-2: returns 404 when id does not exist', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/api/scheduling/workflows/nonexistent-id')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKFLOW_NOT_FOUND');
  });
});

// ─── REQ-WF-CREATE-1..5: POST /workflows ─────────────────────────────────────

describe('POST /api/scheduling/workflows', () => {
  it('REQ-WF-CREATE-1: valid body creates workflow with 201', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling/workflows')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'My Workflow', description: 'desc', stages: [{ name: 'Nuevo', category: 'nuevo', order: 0 }] });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My Workflow');
    expect(res.body.stages).toHaveLength(1);
  });

  it('REQ-WF-CREATE-2: empty name → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling/workflows')
      .set('Cookie', 'auth_token=fake')
      .send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-WF-CREATE-3: invalid stage category → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling/workflows')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'WF', stages: [{ name: 'S', category: 'DONE', order: 0 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-WF-CREATE-4: duplicate name → 409 WORKFLOW_NAME_CONFLICT', async () => {
    const app = buildApp();
    await request(app).post('/api/scheduling/workflows').set('Cookie', 'auth_token=fake').send({ name: 'WF1' });
    const res = await request(app).post('/api/scheduling/workflows').set('Cookie', 'auth_token=fake').send({ name: 'WF1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('WORKFLOW_NAME_CONFLICT');
  });

  it('REQ-WF-CREATE-5: empty stages array → 201', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling/workflows')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Empty WF', stages: [] });
    expect(res.status).toBe(201);
    expect(res.body.stages).toHaveLength(0);
  });
});

// ─── REQ-WF-UPDATE-1..3: PUT /workflows/:id ──────────────────────────────────

describe('PUT /api/scheduling/workflows/:id', () => {
  it('REQ-WF-UPDATE-1: valid partial body → 200', async () => {
    const app = buildApp();
    const create = await request(app).post('/api/scheduling/workflows').set('Cookie', 'auth_token=fake').send({ name: 'WFX' });
    const res = await request(app).put(`/api/scheduling/workflows/${create.body.id}`).set('Cookie', 'auth_token=fake').send({ name: 'WFX Updated' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('WFX Updated');
  });

  it('REQ-WF-UPDATE-2: unknown id → 404 WORKFLOW_NOT_FOUND', async () => {
    const app = buildApp();
    const res = await request(app).put('/api/scheduling/workflows/bad-id').set('Cookie', 'auth_token=fake').send({ name: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKFLOW_NOT_FOUND');
  });
});

// ─── REQ-WF-DELETE-1..4: DELETE /workflows/:id ───────────────────────────────

describe('DELETE /api/scheduling/workflows/:id', () => {
  it('REQ-WF-DELETE-1: deletes existing workflow → 204', async () => {
    const app = buildApp();
    const create = await request(app).post('/api/scheduling/workflows').set('Cookie', 'auth_token=fake').send({ name: 'ToDelete' });
    const res = await request(app).delete(`/api/scheduling/workflows/${create.body.id}`).set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(204);
  });

  it('REQ-WF-DELETE-2: unknown id → 404 WORKFLOW_NOT_FOUND', async () => {
    const app = buildApp();
    const res = await request(app).delete('/api/scheduling/workflows/bad-id').set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('REQ-WF-DELETE-4: Default workflow → 409 DEFAULT_WORKFLOW_PROTECTED', async () => {
    const app = buildApp();
    const create = await request(app).post('/api/scheduling/workflows').set('Cookie', 'auth_token=fake').send({ name: 'Default' });
    const res = await request(app).delete(`/api/scheduling/workflows/${create.body.id}`).set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DEFAULT_WORKFLOW_PROTECTED');
  });
});

// ─── REQ-STAGE-ADD-1..4: POST /workflows/:id/stages ─────────────────────────

describe('POST /api/scheduling/workflows/:id/stages', () => {
  it('REQ-STAGE-ADD-1: valid body → 201', async () => {
    const app = buildApp();
    const create = await request(app).post('/api/scheduling/workflows').set('Cookie', 'auth_token=fake').send({ name: 'WF' });
    const res = await request(app)
      .post(`/api/scheduling/workflows/${create.body.id}/stages`)
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Nuevo', category: 'nuevo', order: 0 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Nuevo');
  });

  it('REQ-STAGE-ADD-2: missing fields → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const create = await request(app).post('/api/scheduling/workflows').set('Cookie', 'auth_token=fake').send({ name: 'WF' });
    const res = await request(app)
      .post(`/api/scheduling/workflows/${create.body.id}/stages`)
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'S' }); // missing category and order
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-STAGE-ADD-3: workflow not found → 404 WORKFLOW_NOT_FOUND', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling/workflows/nonexistent/stages')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'S', category: 'nuevo', order: 0 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKFLOW_NOT_FOUND');
  });
});

// ─── REQ-STAGE-REORDER-1..3: PUT /workflows/:id/stages/reorder ───────────────

describe('PUT /api/scheduling/workflows/:id/stages/reorder', () => {
  it('REQ-STAGE-REORDER-1: valid order → 200', async () => {
    const app = buildApp();
    const create = await request(app)
      .post('/api/scheduling/workflows')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'WF-R', stages: [{ name: 'A', category: 'nuevo', order: 0 }, { name: 'B', category: 'hecho', order: 1 }] });

    const stageIds = create.body.stages.map((s: any) => s.id);
    const res = await request(app)
      .put(`/api/scheduling/workflows/${create.body.id}/stages/reorder`)
      .set('Cookie', 'auth_token=fake')
      .send({ order: [stageIds[1], stageIds[0]] });
    expect(res.status).toBe(200);
  });

  it('REQ-STAGE-REORDER-3: workflow not found → 404', async () => {
    const app = buildApp();
    const res = await request(app)
      .put('/api/scheduling/workflows/nonexistent/stages/reorder')
      .set('Cookie', 'auth_token=fake')
      .send({ order: ['550e8400-e29b-41d4-a716-446655440001'] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKFLOW_NOT_FOUND');
  });
});

// ─── REQ-PC/PT: ProjectCategory + ProjectType basic routes ───────────────────

describe('GET /api/scheduling/project-categories', () => {
  it('returns 200 with empty array', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/scheduling/project-categories').set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/scheduling/project-categories', () => {
  it('REQ-PC-CREATE-1: creates category → 201', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling/project-categories')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Cat A' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Cat A');
  });

  it('REQ-PC-VALIDATION-1: empty name → 400 VALIDATION_ERROR', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling/project-categories')
      .set('Cookie', 'auth_token=fake')
      .send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-PC-CREATE-2: duplicate name → 409 PROJECT_CATEGORY_NAME_CONFLICT', async () => {
    const app = buildApp();
    await request(app).post('/api/scheduling/project-categories').set('Cookie', 'auth_token=fake').send({ name: 'Cat' });
    const res = await request(app).post('/api/scheduling/project-categories').set('Cookie', 'auth_token=fake').send({ name: 'Cat' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROJECT_CATEGORY_NAME_CONFLICT');
  });
});

describe('GET /api/scheduling/project-types', () => {
  it('returns 200 with empty array', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/scheduling/project-types').set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/scheduling/project-types', () => {
  it('REQ-PT-CREATE-1: creates type → 201', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/scheduling/project-types')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Instalacion' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Instalacion');
  });
});

// ─── T-24 (REQ-DTO-1, REQ-CODE-1): code in DTO response ─────────────────────

describe('T-24: code field in stage DTO responses', () => {
  it('T-24: POST /workflows/:id/stages → 201 with code in response body', async () => {
    const app = buildApp();
    const create = await request(app)
      .post('/api/scheduling/workflows')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'WF-DTO' });
    const res = await request(app)
      .post(`/api/scheduling/workflows/${create.body.id}/stages`)
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Mi Etapa', category: 'nuevo', order: 0 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('code');
    expect(res.body.code).toBe('mi_etapa');
  });

  it('T-24: GET /workflows returns stages with non-null code field', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/scheduling/workflows')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'WF-GET-CODE', stages: [{ name: 'Nuevo', category: 'nuevo', order: 0 }] });
    const res = await request(app)
      .get('/api/scheduling/workflows')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    const stages = res.body[0].stages;
    expect(stages).toHaveLength(1);
    expect(stages[0]).toHaveProperty('code');
    expect(stages[0].code).toBe('nuevo');
  });

  it('T-24: code in POST body is ignored — autogenerated slug is used (REQ-CODE-1)', async () => {
    const app = buildApp();
    const create = await request(app)
      .post('/api/scheduling/workflows')
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'WF-IGNORE-CODE' });
    const res = await request(app)
      .post(`/api/scheduling/workflows/${create.body.id}/stages`)
      .set('Cookie', 'auth_token=fake')
      .send({ name: 'Nueva Etapa', category: 'nuevo', order: 0, code: 'custom_code_injected' });
    expect(res.status).toBe(201);
    // code must be the autogenerated slug, NOT the custom value
    expect(res.body.code).toBe('nueva_etapa');
    expect(res.body.code).not.toBe('custom_code_injected');
  });
});

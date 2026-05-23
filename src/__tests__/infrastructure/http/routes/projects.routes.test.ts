import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryProjectRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { InMemoryProjectCategoryRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryProjectCategoryRepository';
import { InMemoryProjectTypeRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryProjectTypeRepository';
import { InMemoryWorkflowRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryWorkflowRepository';
import { InMemoryAdminRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryAdminRepository';
import { InMemoryPartnerRepository } from '../../../../infrastructure/adapters/in-memory/InMemoryPartnerRepository';
import { createProjectsRouter } from '../../../../infrastructure/http/routes/projects.routes';
import { ListProjects } from '../../../../application/use-cases/ListProjects';
import { GetProject } from '../../../../application/use-cases/GetProject';
import { CreateProject } from '../../../../application/use-cases/CreateProject';
import { UpdateProject } from '../../../../application/use-cases/UpdateProject';
import { DeleteProject } from '../../../../application/use-cases/DeleteProject';
import { User } from '../../../../domain/entities/auth';
import { AuthProvider } from '../../../../domain/ports/AuthProvider';
import { AuthenticationError } from '../../../../domain/errors';

const VALID_UUID = '00000000-0000-4000-a000-000000000001';

class FakeAuthProvider implements AuthProvider {
  constructor(private readonly fail: boolean = false) {}
  async login() {
    return { user: { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    if (this.fail) throw new AuthenticationError('Invalid token');
    return { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

interface BuildAppOptions {
  authed?: boolean;
  failAuth?: boolean;
}

async function buildApp(opts: BuildAppOptions = {}) {
  const { authed = true, failAuth = false } = opts;
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const projectRepo = new InMemoryProjectRepository();
  const categoryRepo = new InMemoryProjectCategoryRepository();
  const typeRepo = new InMemoryProjectTypeRepository();
  const workflowRepo = new InMemoryWorkflowRepository();
  const adminRepo = new InMemoryAdminRepository();
  const partnerRepo = new InMemoryPartnerRepository();

  const authProvider = failAuth ? new FakeAuthProvider(true) : new FakeAuthProvider(false);

  const listProjects = new ListProjects(projectRepo);
  const getProject = new GetProject(projectRepo);
  const createProject = new CreateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
  const updateProject = new UpdateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
  const deleteProject = new DeleteProject(projectRepo);

  app.use('/api/projects', createProjectsRouter(listProjects, getProject, createProject, updateProject, deleteProject, authProvider));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo };
}

const AUTH_COOKIE = 'auth_token=fake';

// ─── REQ-AUTH: All routes reject unauthenticated requests ────────────────────

describe('Auth: routes reject missing cookie', () => {
  it('REQ-AUTH-1: GET / → 401 UNAUTHORIZED', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('REQ-AUTH-2: GET /:id → 401 UNAUTHORIZED', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/projects/some-id');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('REQ-AUTH-3: POST / → 401 UNAUTHORIZED', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').send({ title: 'T' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('REQ-AUTH-4: PUT /:id → 401 UNAUTHORIZED', async () => {
    const { app } = await buildApp();
    const res = await request(app).put('/api/projects/some-id').send({ title: 'T' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('REQ-AUTH-5: DELETE /:id → 401 UNAUTHORIZED', async () => {
    const { app } = await buildApp();
    const res = await request(app).delete('/api/projects/some-id');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('REQ-AUTH-6: invalid token rejected', async () => {
    const { app } = await buildApp({ failAuth: true });
    const res = await request(app).get('/api/projects').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(401);
    expect(res.body.code).toBeDefined();
  });

  it('REQ-AUTH-7: valid token allowed through', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/projects').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
  });
});

// ─── REQ-LIST ─────────────────────────────────────────────────────────────────

describe('GET /api/projects', () => {
  it('REQ-LIST-3: returns 200 with [] when empty', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/projects').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('REQ-LIST-1: returns projects array with taskCounts', async () => {
    const { app, projectRepo } = await buildApp();
    await projectRepo.create({ title: 'P1' });
    const res = await request(app).get('/api/projects').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].taskCounts).toEqual({ nuevo: 0, enProgreso: 0, hecho: 0, total: 0 });
  });

  it('REQ-LIST-4: visible=true filter excludes hidden projects', async () => {
    const { app, projectRepo } = await buildApp();
    await projectRepo.create({ title: 'Visible', visible: true });
    await projectRepo.create({ title: 'Hidden', visible: false });
    const res = await request(app).get('/api/projects?visible=true').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Visible');
  });

  it('REQ-LIST-4: no visible filter defaults to visible=true (soft-deleted hidden)', async () => {
    const { app, projectRepo } = await buildApp();
    await projectRepo.create({ title: 'Visible', visible: true });
    await projectRepo.create({ title: 'Hidden', visible: false });
    const res = await request(app).get('/api/projects').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Visible');
  });

  it('REQ-LIST-4: visible=all returns both enabled and disabled projects', async () => {
    const { app, projectRepo } = await buildApp();
    await projectRepo.create({ title: 'Visible', visible: true });
    await projectRepo.create({ title: 'Hidden', visible: false });
    const res = await request(app).get('/api/projects?visible=all').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('returns 400 for invalid visible query value', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/projects?visible=yes').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ─── REQ-GET ──────────────────────────────────────────────────────────────────

describe('GET /api/projects/:id', () => {
  it('REQ-GET-1: returns 200 with project', async () => {
    const { app, projectRepo } = await buildApp();
    const project = await projectRepo.create({ title: 'P' });
    const res = await request(app).get(`/api/projects/${project.id}`).set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(project.id);
    expect(res.body.taskCounts).toBeDefined();
  });

  it('REQ-GET-2: returns 404 PROJECT_NOT_FOUND when missing', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/projects/nonexistent').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });
});

// ─── REQ-CREATE ──────────────────────────────────────────────────────────────

describe('POST /api/projects', () => {
  it('REQ-CREATE-1: valid body returns 201 with created project', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({ title: 'My Project' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.title).toBe('My Project');
    expect(res.body.visible).toBe(true);
    expect(res.body.partners).toEqual([]);
    expect(res.body.taskCounts).toEqual({ nuevo: 0, enProgreso: 0, hecho: 0, total: 0 });
  });

  it('REQ-CREATE-2: missing title returns 400 VALIDATION_ERROR', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-CREATE-2: empty title returns 400 VALIDATION_ERROR', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({ title: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-CREATE-3: visible:"yes" returns 400 VALIDATION_ERROR', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({ title: 'T', visible: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-CREATE-3: partnerIds as string returns 400 VALIDATION_ERROR', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({ title: 'T', partnerIds: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-CREATE-4: unknown categoryId returns 404 CATEGORY_NOT_FOUND', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({ title: 'T', categoryId: VALID_UUID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CATEGORY_NOT_FOUND');
  });

  it('REQ-CREATE-5: unknown typeId returns 404 TYPE_NOT_FOUND', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({ title: 'T', typeId: VALID_UUID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TYPE_NOT_FOUND');
  });

  it('REQ-CREATE-6: unknown workflowId returns 404 WORKFLOW_NOT_FOUND', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({ title: 'T', workflowId: VALID_UUID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('REQ-CREATE-7: unknown projectLeadId returns 404 LEAD_NOT_FOUND', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({ title: 'T', projectLeadId: VALID_UUID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('LEAD_NOT_FOUND');
  });

  it('REQ-CREATE-8: unknown partnerId in partnerIds returns 404 PARTNER_NOT_FOUND', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({ title: 'T', partnerIds: [VALID_UUID] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PARTNER_NOT_FOUND');
  });

  it('REQ-CREATE-9: all optional fields null accepted', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({
      title: 'T', description: null, typeId: null, categoryId: null, workflowId: null, projectLeadId: null,
    });
    expect(res.status).toBe(201);
    expect(res.body.description).toBeNull();
  });

  it('REQ-CREATE-10: omitting partnerIds gives empty partners array', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/projects').set('Cookie', AUTH_COOKIE).send({ title: 'T' });
    expect(res.status).toBe(201);
    expect(res.body.partners).toEqual([]);
  });
});

// ─── REQ-UPDATE ──────────────────────────────────────────────────────────────

describe('PUT /api/projects/:id', () => {
  it('REQ-UPDATE-1: valid partial body returns 200', async () => {
    const { app, projectRepo } = await buildApp();
    const project = await projectRepo.create({ title: 'Old' });
    const res = await request(app).put(`/api/projects/${project.id}`).set('Cookie', AUTH_COOKIE).send({ title: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('New');
  });

  it('REQ-UPDATE-2: unknown ID returns 404 PROJECT_NOT_FOUND', async () => {
    const { app } = await buildApp();
    const res = await request(app).put('/api/projects/nonexistent').set('Cookie', AUTH_COOKIE).send({ title: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });

  it('REQ-UPDATE-3: invalid field type returns 400 VALIDATION_ERROR', async () => {
    const { app, projectRepo } = await buildApp();
    const project = await projectRepo.create({ title: 'P' });
    const res = await request(app).put(`/api/projects/${project.id}`).set('Cookie', AUTH_COOKIE).send({ visible: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('REQ-UPDATE-4: unknown FK returns 404 with right code', async () => {
    const { app, projectRepo } = await buildApp();
    const project = await projectRepo.create({ title: 'P' });
    const res = await request(app).put(`/api/projects/${project.id}`).set('Cookie', AUTH_COOKIE).send({ categoryId: VALID_UUID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CATEGORY_NOT_FOUND');
  });

  it('REQ-UPDATE-5: setting FK to null is permitted', async () => {
    const { app, projectRepo, categoryRepo } = await buildApp();
    const cat = await categoryRepo.create({ name: 'C', description: null });
    const project = await projectRepo.create({ title: 'P', categoryId: cat.id });
    const res = await request(app).put(`/api/projects/${project.id}`).set('Cookie', AUTH_COOKIE).send({ categoryId: null });
    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBeNull();
  });
});

// ─── REQ-PARTNERS ────────────────────────────────────────────────────────────

describe('Partner replace-set semantics (PUT)', () => {
  it('REQ-PARTNERS-1: PUT with non-empty partnerIds returns the new set in response body', async () => {
    const { app, projectRepo, partnerRepo } = await buildApp();
    const p1 = await partnerRepo.findById('1');
    const p2 = await partnerRepo.findById('2');
    const project = await projectRepo.create({ title: 'P', partnerIds: [p1!.id] });
    const res = await request(app)
      .put(`/api/projects/${project.id}`)
      .set('Cookie', AUTH_COOKIE)
      .send({ partnerIds: [p2!.id] });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.partners)).toBe(true);
    expect(res.body.partners).toHaveLength(1);
    expect(res.body.partners[0].id).toBe(p2!.id);
  });

  it('REQ-PARTNERS-2: empty partnerIds removes all partners', async () => {
    const { app, projectRepo, partnerRepo } = await buildApp();
    const p1 = await partnerRepo.findById('1');
    const project = await projectRepo.create({ title: 'P', partnerIds: [p1!.id] });
    const res = await request(app).put(`/api/projects/${project.id}`).set('Cookie', AUTH_COOKIE).send({ partnerIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.partners).toEqual([]);
  });

  it('REQ-PARTNERS-3: omitting partnerIds preserves existing set', async () => {
    const { app, projectRepo, partnerRepo } = await buildApp();
    const p1 = await partnerRepo.findById('1');
    const project = await projectRepo.create({ title: 'P', partnerIds: [p1!.id] });
    const res = await request(app).put(`/api/projects/${project.id}`).set('Cookie', AUTH_COOKIE).send({ title: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated');
    expect(res.body.partners).toHaveLength(1);
    expect(res.body.partners[0].id).toBe(p1!.id);
  });

  it('REQ-PARTNERS-4: unknown partner in PUT returns 404 PARTNER_NOT_FOUND', async () => {
    const { app, projectRepo } = await buildApp();
    const project = await projectRepo.create({ title: 'P' });
    const res = await request(app).put(`/api/projects/${project.id}`).set('Cookie', AUTH_COOKIE).send({ partnerIds: [VALID_UUID] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PARTNER_NOT_FOUND');
  });
});

// ─── REQ-DELETE ──────────────────────────────────────────────────────────────

describe('DELETE /api/projects/:id', () => {
  it('REQ-DELETE-1: returns 204 on success', async () => {
    const { app, projectRepo } = await buildApp();
    const project = await projectRepo.create({ title: 'P' });
    const res = await request(app).delete(`/api/projects/${project.id}`).set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('REQ-DELETE-2: returns 404 PROJECT_NOT_FOUND', async () => {
    const { app } = await buildApp();
    const res = await request(app).delete('/api/projects/nonexistent').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });
});

// ─── REQ-SHAPE ────────────────────────────────────────────────────────────────

describe('Response shape', () => {
  it('REQ-SHAPE-1: project response has all required fields', async () => {
    const { app, projectRepo } = await buildApp();
    await projectRepo.create({ title: 'Shape Test' });
    const res = await request(app).get('/api/projects').set('Cookie', AUTH_COOKIE);
    const p = res.body[0];
    expect(p.id).toBeDefined();
    expect(p.title).toBeDefined();
    expect('description' in p).toBe(true);
    expect('typeId' in p).toBe(true);
    expect('categoryId' in p).toBe(true);
    expect('workflowId' in p).toBe(true);
    expect('projectLeadId' in p).toBe(true);
    expect(typeof p.visible).toBe('boolean');
    expect(Array.isArray(p.partners)).toBe(true);
    expect(p.taskCounts).toBeDefined();
    expect(p.createdAt).toBeDefined();
    expect(p.updatedAt).toBeDefined();
  });

  it('REQ-SHAPE-3: partners is always an array (never null/absent)', async () => {
    const { app, projectRepo } = await buildApp();
    await projectRepo.create({ title: 'P' });
    const res = await request(app).get('/api/projects').set('Cookie', AUTH_COOKIE);
    expect(Array.isArray(res.body[0].partners)).toBe(true);
  });
});

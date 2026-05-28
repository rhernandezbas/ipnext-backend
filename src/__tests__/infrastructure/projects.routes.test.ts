/**
 * Route tests for /api/projects/* endpoints.
 * Covers iclassSoTypeId assignment (REQ-PROJ-3..8) plus existing CRUD.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryProjectRepository } from '../../infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { InMemoryIClassSoTypeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassSoTypeRepository';
import { ListProjects } from '../../application/use-cases/ListProjects';
import { GetProject } from '../../application/use-cases/GetProject';
import { CreateProject } from '../../application/use-cases/CreateProject';
import { UpdateProject } from '../../application/use-cases/UpdateProject';
import { DeleteProject } from '../../application/use-cases/DeleteProject';
import { AssignIClassSoTypeToProject } from '../../application/use-cases/AssignIClassSoTypeToProject';
import { createProjectsRouter } from '../../infrastructure/http/routes/projects.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'testuser', email: 'test@test.com', role: 'admin' };
  }
}

// Stub repo for FK lookups (always returns {id})
class StubRepo<T> {
  async getById(id: string): Promise<{ id: string } | null> { return { id }; }
  async findById(id: string): Promise<{ id: string } | null> { return { id }; }
}

async function buildApp() {
  const projectRepo = new InMemoryProjectRepository();
  const soTypeRepo = new InMemoryIClassSoTypeRepository();

  // Seed an active SO type
  await soTypeRepo.upsertByCode({ code: 'INSTALACION FIBRA', description: 'Instalación Fibra' });
  const types = await soTypeRepo.list();
  const activeType = types.find(t => t.code === 'INSTALACION FIBRA')!;

  // Seed an inactive SO type
  await soTypeRepo.upsertByCode({ code: 'OLD_TYPE', description: 'Tipo Viejo' });
  await soTypeRepo.markInactiveExcept(['INSTALACION FIBRA']); // OLD_TYPE becomes inactive

  const allTypes = await soTypeRepo.list();
  const inactiveType = allTypes.find(t => t.code === 'OLD_TYPE')!;

  // Seed a project
  const project = await projectRepo.create({
    title: 'Proyecto FTTH',
    description: null,
    visible: true,
  });

  // Register SO types in the project repo soTypeCache for updateIClassSoType to work
  projectRepo.seedIClassSoType({ id: activeType.id, code: activeType.code, description: activeType.description, active: activeType.active });
  projectRepo.seedIClassSoType({ id: inactiveType.id, code: inactiveType.code, description: inactiveType.description, active: inactiveType.active });

  const stubRepo = new StubRepo();
  const assignUC = new AssignIClassSoTypeToProject(projectRepo, soTypeRepo);

  // Stub repos for CreateProject/UpdateProject FK lookups
  const categoryRepo = { getById: async () => null };
  const typeRepo = { getById: async () => null };
  const workflowRepo = { getById: async () => null };
  const adminRepo = { findById: async (id: string) => ({ id }) };
  const partnerRepo = { findById: async () => null };

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/projects',
    createProjectsRouter(
      new ListProjects(projectRepo),
      new GetProject(projectRepo),
      new CreateProject(projectRepo, categoryRepo as never, typeRepo as never, workflowRepo as never, adminRepo as never, partnerRepo as never),
      new UpdateProject(projectRepo, categoryRepo as never, typeRepo as never, workflowRepo as never, adminRepo as never, partnerRepo as never),
      new DeleteProject(projectRepo),
      new FakeAuthProvider(),
      assignUC,
    ),
  );
  app.use(errorHandler);

  return { app, projectRepo, soTypeRepo, project, activeType, inactiveType };
}

// ─── GET /api/projects (list) ─────────────────────────────────────────────────

describe('GET /api/projects', () => {
  it('REQ-PROJ-8: includes iclassSoTypeId and iclassSoType in list response', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .get('/api/projects')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const project = res.body[0];
    expect(project).toHaveProperty('iclassSoTypeId');
    expect(project).toHaveProperty('iclassSoType');
  });

  it('returns 401 without auth', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/projects/:id ────────────────────────────────────────────────────

describe('GET /api/projects/:id', () => {
  it('REQ-PROJ-8: includes iclassSoTypeId and iclassSoType in single project response', async () => {
    const { app, project } = await buildApp();

    const res = await request(app)
      .get(`/api/projects/${project.id}`)
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('iclassSoTypeId');
    expect(res.body).toHaveProperty('iclassSoType');
  });
});

// ─── PATCH /api/projects/:id (iclassSoTypeId assignment) ─────────────────────

describe('PATCH /api/projects/:id — iclassSoTypeId assignment', () => {
  it('REQ-PROJ-6: assigns active SO type → 200 with iclassSoType populated', async () => {
    const { app, project, activeType } = await buildApp();

    const res = await request(app)
      .patch(`/api/projects/${project.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ iclassSoTypeId: activeType.id });

    expect(res.status).toBe(200);
    expect(res.body.iclassSoTypeId).toBe(activeType.id);
    expect(res.body.iclassSoType).not.toBeNull();
    expect(res.body.iclassSoType.code).toBe('INSTALACION FIBRA');
  });

  it('REQ-PROJ-5: setting null clears the mapping → 200 with iclassSoType: null', async () => {
    const { app, project, activeType } = await buildApp();

    // First assign
    await request(app)
      .patch(`/api/projects/${project.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ iclassSoTypeId: activeType.id });

    // Then clear
    const res = await request(app)
      .patch(`/api/projects/${project.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ iclassSoTypeId: null });

    expect(res.status).toBe(200);
    expect(res.body.iclassSoTypeId).toBeNull();
    expect(res.body.iclassSoType).toBeNull();
  });

  it('REQ-PROJ-4: non-existent type id → 404 ICLASS_SO_TYPE_NOT_FOUND', async () => {
    const { app, project } = await buildApp();

    const res = await request(app)
      .patch(`/api/projects/${project.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ iclassSoTypeId: '00000000-0000-4000-a000-000000000999' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ICLASS_SO_TYPE_NOT_FOUND');
  });

  it('REQ-PROJ-3: inactive type id → 422 ICLASS_SO_TYPE_INACTIVE', async () => {
    const { app, project, inactiveType } = await buildApp();

    const res = await request(app)
      .patch(`/api/projects/${project.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ iclassSoTypeId: inactiveType.id });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ICLASS_SO_TYPE_INACTIVE');
  });

  it('REQ-PROJ-7: non-string iclassSoTypeId → 400 VALIDATION_ERROR', async () => {
    const { app, project } = await buildApp();

    const res = await request(app)
      .patch(`/api/projects/${project.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ iclassSoTypeId: 123 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 without auth', async () => {
    const { app, project, activeType } = await buildApp();

    const res = await request(app)
      .patch(`/api/projects/${project.id}`)
      .send({ iclassSoTypeId: activeType.id });

    expect(res.status).toBe(401);
  });

  it('non-iclassSoTypeId fields are still updated', async () => {
    const { app, project } = await buildApp();

    const res = await request(app)
      .patch(`/api/projects/${project.id}`)
      .set('Cookie', 'auth_token=fake')
      .send({ title: 'Nuevo Título' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Nuevo Título');
  });
});

// ─── POST /api/projects ───────────────────────────────────────────────────────

describe('POST /api/projects', () => {
  it('REQ-PROJ-8: created project includes iclassSoTypeId and iclassSoType fields', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/api/projects')
      .set('Cookie', 'auth_token=fake')
      .send({ title: 'New Project' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('iclassSoTypeId');
    expect(res.body).toHaveProperty('iclassSoType');
    expect(res.body.iclassSoTypeId).toBeNull();
    expect(res.body.iclassSoType).toBeNull();
  });
});

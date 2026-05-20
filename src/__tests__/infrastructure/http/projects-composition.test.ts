/**
 * Composition sanity test: ensures projectsRouter resolves correctly when
 * mounted at /api/projects. Guards against future router-shadowing issues
 * (per change-1 lesson: /:id catch-all can swallow sub-paths if ordering is wrong).
 *
 * Currently /api/projects has only one router, so no sibling conflict exists.
 * This test future-proofs for when e.g. /api/projects/templates is added.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryProjectRepository } from '../../../infrastructure/adapters/in-memory/InMemoryProjectRepository';
import { InMemoryProjectCategoryRepository } from '../../../infrastructure/adapters/in-memory/InMemoryProjectCategoryRepository';
import { InMemoryProjectTypeRepository } from '../../../infrastructure/adapters/in-memory/InMemoryProjectTypeRepository';
import { InMemoryWorkflowRepository } from '../../../infrastructure/adapters/in-memory/InMemoryWorkflowRepository';
import { InMemoryAdminRepository } from '../../../infrastructure/adapters/in-memory/InMemoryAdminRepository';
import { InMemoryPartnerRepository } from '../../../infrastructure/adapters/in-memory/InMemoryPartnerRepository';
import { createProjectsRouter } from '../../../infrastructure/http/routes/projects.routes';
import { ListProjects } from '../../../application/use-cases/ListProjects';
import { GetProject } from '../../../application/use-cases/GetProject';
import { CreateProject } from '../../../application/use-cases/CreateProject';
import { UpdateProject } from '../../../application/use-cases/UpdateProject';
import { DeleteProject } from '../../../application/use-cases/DeleteProject';
import { User } from '../../../domain/entities/auth';
import { AuthProvider } from '../../../domain/ports/AuthProvider';

class FakeAuthProvider implements AuthProvider {
  async login() {
    return { user: { id: 'a', username: 't', email: 't@t.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'a', username: 't', email: 't@t.com', role: 'admin' };
  }
}

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const projectRepo = new InMemoryProjectRepository();
  const categoryRepo = new InMemoryProjectCategoryRepository();
  const typeRepo = new InMemoryProjectTypeRepository();
  const workflowRepo = new InMemoryWorkflowRepository();
  const adminRepo = new InMemoryAdminRepository();
  const partnerRepo = new InMemoryPartnerRepository();
  const authProvider = new FakeAuthProvider();

  const listProjects = new ListProjects(projectRepo);
  const getProject = new GetProject(projectRepo);
  const createProject = new CreateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
  const updateProject = new UpdateProject(projectRepo, categoryRepo, typeRepo, workflowRepo, adminRepo, partnerRepo);
  const deleteProject = new DeleteProject(projectRepo);

  // Mount projects router at /api/projects (same order as app.ts)
  app.use('/api/projects', createProjectsRouter(listProjects, getProject, createProject, updateProject, deleteProject, authProvider));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, projectRepo };
}

const COOKIE = 'auth_token=fake';

describe('Composition: projects router mounted at /api/projects', () => {
  it('GET /api/projects returns 200 array', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/projects').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/projects/:id returns 404 PROJECT_NOT_FOUND for unknown id', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/projects/00000000-0000-4000-a000-000000000099').set('Cookie', COOKIE);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });

  it('PUT /api/projects/:id returns 404 PROJECT_NOT_FOUND for unknown id', async () => {
    const { app } = buildApp();
    const res = await request(app).put('/api/projects/00000000-0000-4000-a000-000000000099').set('Cookie', COOKIE).send({ title: 'T' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });

  it('GET /api/projects/:id returns 200 for existing project (no shadowing)', async () => {
    const { app, projectRepo } = buildApp();
    const project = await projectRepo.create({ title: 'Shadow Test' });
    const res = await request(app).get(`/api/projects/${project.id}`).set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(project.id);
    expect(res.body).not.toEqual({ error: expect.any(String), code: 'PROJECT_NOT_FOUND' });
  });
});

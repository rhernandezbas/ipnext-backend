/**
 * Route tests for /api/admin/iclass/technician-teams (F1-F4).
 * STRICT TDD — tests before router implementation.
 *
 * F1: GET 200 returns items
 * F2: GET 403 without permission
 * F3: PATCH 200 sets mapping
 * F4: PATCH 400 on invalid body; 422 on non-assignable team; 404 on unknown user
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryIClassTeamRepository } from '@infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { SetTechnicianTeamMapping } from '@application/use-cases/SetTechnicianTeamMapping';
import { ListTechnicianTeamMappings } from '@application/use-cases/ListTechnicianTeamMappings';
import { createIClassTechnicianTeamsRouter } from '@infrastructure/http/routes/iclassTechnicianTeams.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { User } from '@domain/entities/auth';
import { AuthProvider } from '@domain/ports/AuthProvider';

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'a', username: 'u', email: 'e@e.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_t: string): Promise<User> {
    return { id: 'a', username: 'u', email: 'e@e.com', role: 'admin' };
  }
}

const ALLOW: RequestHandler = (_req, _res, next) => next();
const DENY: RequestHandler = (_req: Request, res: Response, _next: NextFunction): void => {
  res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
};

async function buildApp(opts: { denyRead?: boolean; denyManage?: boolean } = {}) {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository(roleRepo);
  const teamRepo = new InMemoryIClassTeamRepository();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo, teamRepo);

  // Seed role
  const tecnicoRole = await roleRepo.create({ code: 'tecnico', label: 'Técnico', isSystem: true });

  // Seed team
  await teamRepo.upsertByLogin({ login: 'equipe-01', name: 'Equipe 01', thirdPartyCode: null, active: true, selectable: true });
  await teamRepo.upsertByLogin({ login: 'equipe-inactiva', name: 'Inactiva', thirdPartyCode: null, active: false, selectable: true });

  // Seed user with tecnico role so it appears in the listing
  const user = await userRepo.create({ name: 'Tech Uno', email: 'tech@test.com', login: 'tech1', passwordHash: 'h' });
  await userRoleRepo.assign(user.id, tecnicoRole.id);

  const listUC = new ListTechnicianTeamMappings(userRepo);
  const setUC = new SetTechnicianTeamMapping(userRepo, teamRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/admin/iclass',
    createIClassTechnicianTeamsRouter(
      listUC,
      setUC,
      new FakeAuthProvider(),
      opts.denyRead ? DENY : ALLOW,
      opts.denyManage ? DENY : ALLOW,
    ),
  );
  app.use(errorHandler);

  return { app, userId: user.id };
}

// ─── F1: GET /api/admin/iclass/technician-teams ─────────────────────────────

describe('F1: GET /api/admin/iclass/technician-teams', () => {
  it('F1a: 200 returns items array', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .get('/api/admin/iclass/technician-teams')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.items)).toBe(true);
    const item = res.body.items[0];
    expect(item).toHaveProperty('userId');
    expect(item).toHaveProperty('iclassTeamLogin');
    expect(item).toHaveProperty('teamActive');
  });

  it('F2: 403 without iclass.read permission', async () => {
    const { app } = await buildApp({ denyRead: true });
    const res = await request(app)
      .get('/api/admin/iclass/technician-teams')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(403);
  });
});

// ─── F3: PATCH /api/admin/iclass/technician-teams/:userId ───────────────────

describe('F3/F4: PATCH /api/admin/iclass/technician-teams/:userId', () => {
  it('F3: 200 sets team mapping', async () => {
    const { app, userId } = await buildApp();
    const res = await request(app)
      .patch(`/api/admin/iclass/technician-teams/${userId}`)
      .set('Cookie', 'auth_token=fake')
      .send({ iclassTeamLogin: 'equipe-01' });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(userId);
    expect(res.body.iclassTeamLogin).toBe('equipe-01');
  });

  it('F4a: 400 on invalid body (missing iclassTeamLogin)', async () => {
    const { app, userId } = await buildApp();
    const res = await request(app)
      .patch(`/api/admin/iclass/technician-teams/${userId}`)
      .set('Cookie', 'auth_token=fake')
      .send({ wrong: 'field' });

    expect(res.status).toBe(400);
  });

  it('F4b: 422 when team is not assignable (inactive)', async () => {
    const { app, userId } = await buildApp();
    const res = await request(app)
      .patch(`/api/admin/iclass/technician-teams/${userId}`)
      .set('Cookie', 'auth_token=fake')
      .send({ iclassTeamLogin: 'equipe-inactiva' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ICLASS_TEAM_NOT_ASSIGNABLE');
  });

  it('F4c: 404 when userId does not exist', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .patch('/api/admin/iclass/technician-teams/non-existent-id')
      .set('Cookie', 'auth_token=fake')
      .send({ iclassTeamLogin: 'equipe-01' });

    expect(res.status).toBe(404);
  });

  it('F4d: 200 when desmapping with null', async () => {
    const { app, userId } = await buildApp();
    const res = await request(app)
      .patch(`/api/admin/iclass/technician-teams/${userId}`)
      .set('Cookie', 'auth_token=fake')
      .send({ iclassTeamLogin: null });

    expect(res.status).toBe(200);
    expect(res.body.iclassTeamLogin).toBeNull();
  });

  it('F4e: 403 without iclass.manage permission', async () => {
    const { app, userId } = await buildApp({ denyManage: true });
    const res = await request(app)
      .patch(`/api/admin/iclass/technician-teams/${userId}`)
      .set('Cookie', 'auth_token=fake')
      .send({ iclassTeamLogin: 'equipe-01' });

    expect(res.status).toBe(403);
  });
});

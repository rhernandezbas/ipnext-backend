/**
 * Route tests for /api/admin/gr/* (GR vendedor mapping — Fase 2b).
 * STRICT TDD — tests before router implementation.
 *
 * GET   /vendedor-mappings          → list users + grVendedorName (recapture.assign)
 * PATCH /vendedor-mappings/:userId  → set/clear mapping (recapture.assign)
 * GET   /vendedores                 → distinct GR vendedor catalog (recapture.assign)
 *
 * SECURITY: this is an administration surface (cross-agent). All three routes are
 * gated on recapture.assign (the admin marker). An agente with recapture.manage
 * but WITHOUT recapture.assign must NOT reach any of them.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryContractRepository } from '@infrastructure/adapters/in-memory/InMemoryContractRepository';
import { SetVendedorMapping } from '@application/use-cases/SetVendedorMapping';
import { ListVendedorMappings } from '@application/use-cases/ListVendedorMappings';
import { ListDistinctVendedores } from '@application/use-cases/ListDistinctVendedores';
import { createGrVendedorMappingsRouter } from '@infrastructure/http/routes/grVendedorMappings.routes';
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

async function buildApp(opts: { denyAssign?: boolean } = {}) {
  const userRepo = new InMemoryRbacUserRepository();
  const contractRepo = new InMemoryContractRepository();

  const user = await userRepo.create({ name: 'Vendedor Uno', email: 'v@test.com', login: 'v1', passwordHash: 'h' });
  contractRepo.seed({ clientName: 'C1', plan: 'P', vendedor: 'JUAN PEREZ' });
  contractRepo.seed({ clientName: 'C2', plan: 'P', vendedor: 'ANA GOMEZ' });

  const listMappings = new ListVendedorMappings(userRepo);
  const setMapping = new SetVendedorMapping(userRepo);
  const listVendedores = new ListDistinctVendedores(contractRepo);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/admin/gr',
    createGrVendedorMappingsRouter(
      listMappings,
      setMapping,
      listVendedores,
      new FakeAuthProvider(),
      undefined,
      // Single guard for the whole admin surface: recapture.assign.
      opts.denyAssign ? DENY : ALLOW,
    ),
  );
  app.use(errorHandler);

  return { app, userId: user.id };
}

describe('GET /api/admin/gr/vendedor-mappings', () => {
  it('200 returns items array', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .get('/api/admin/gr/vendedor-mappings')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.items)).toBe(true);
    const item = res.body.items[0];
    expect(item).toHaveProperty('userId');
    expect(item).toHaveProperty('userName');
    expect(item).toHaveProperty('userLogin');
    expect(item).toHaveProperty('grVendedorName');
  });

  it('403 without recapture.assign permission', async () => {
    const { app } = await buildApp({ denyAssign: true });
    const res = await request(app)
      .get('/api/admin/gr/vendedor-mappings')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(403);
  });

  it('403 for an agente with recapture.manage but WITHOUT recapture.assign', async () => {
    // The agente now has recapture.manage; this admin surface must stay gated on
    // assign. denyAssign models "manage granted, assign denied".
    const { app } = await buildApp({ denyAssign: true });
    const res = await request(app)
      .get('/api/admin/gr/vendedor-mappings')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(403);
  });

  it('200 for an admin (recapture.assign granted)', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .get('/api/admin/gr/vendedor-mappings')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/admin/gr/vendedor-mappings/:userId', () => {
  it('200 sets the mapping', async () => {
    const { app, userId } = await buildApp();
    const res = await request(app)
      .patch(`/api/admin/gr/vendedor-mappings/${userId}`)
      .set('Cookie', 'auth_token=fake')
      .send({ grVendedorName: 'JUAN PEREZ' });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(userId);
    expect(res.body.grVendedorName).toBe('JUAN PEREZ');
  });

  it('200 clears the mapping with null', async () => {
    const { app, userId } = await buildApp();
    const res = await request(app)
      .patch(`/api/admin/gr/vendedor-mappings/${userId}`)
      .set('Cookie', 'auth_token=fake')
      .send({ grVendedorName: null });

    expect(res.status).toBe(200);
    expect(res.body.grVendedorName).toBeNull();
  });

  it('400 on invalid body (wrong field)', async () => {
    const { app, userId } = await buildApp();
    const res = await request(app)
      .patch(`/api/admin/gr/vendedor-mappings/${userId}`)
      .set('Cookie', 'auth_token=fake')
      .send({ wrong: 'field' });

    expect(res.status).toBe(400);
  });

  it('404 when userId does not exist', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .patch('/api/admin/gr/vendedor-mappings/non-existent-id')
      .set('Cookie', 'auth_token=fake')
      .send({ grVendedorName: 'JUAN PEREZ' });

    expect(res.status).toBe(404);
  });

  it('403 without recapture.assign permission', async () => {
    const { app, userId } = await buildApp({ denyAssign: true });
    const res = await request(app)
      .patch(`/api/admin/gr/vendedor-mappings/${userId}`)
      .set('Cookie', 'auth_token=fake')
      .send({ grVendedorName: 'JUAN PEREZ' });

    expect(res.status).toBe(403);
  });

  it('403 for an agente with recapture.manage but WITHOUT recapture.assign', async () => {
    // PATCH mutates ANY user's mapping → must be assign-gated, not manage.
    const { app, userId } = await buildApp({ denyAssign: true });
    const res = await request(app)
      .patch(`/api/admin/gr/vendedor-mappings/${userId}`)
      .set('Cookie', 'auth_token=fake')
      .send({ grVendedorName: 'JUAN PEREZ' });

    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/gr/vendedores', () => {
  it('200 returns distinct vendedor names, alphabetically ordered', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .get('/api/admin/gr/vendedores')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(res.body.items).toEqual(['ANA GOMEZ', 'JUAN PEREZ']);
  });

  it('403 without recapture.assign permission', async () => {
    const { app } = await buildApp({ denyAssign: true });
    const res = await request(app)
      .get('/api/admin/gr/vendedores')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(403);
  });

  it('403 for an agente with recapture.manage but WITHOUT recapture.assign', async () => {
    const { app } = await buildApp({ denyAssign: true });
    const res = await request(app)
      .get('/api/admin/gr/vendedores')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(403);
  });
});

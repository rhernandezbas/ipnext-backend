import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createMaterialTypeCatalogRouter } from '@infrastructure/http/routes/materialTypeCatalog.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { MaterialCatalogService } from '@application/services/MaterialCatalogService';
import { ListMaterial } from '@application/use-cases/ListMaterial';
import { GetMaterial } from '@application/use-cases/GetMaterial';
import { CreateMaterial } from '@application/use-cases/CreateMaterial';
import { UpdateMaterial } from '@application/use-cases/UpdateMaterial';
import { DeleteMaterial } from '@application/use-cases/DeleteMaterial';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { RequestHandler } from 'express';
import { InvalidMinStockError } from '@domain/errors/inventory';

// Echo cookie token back as userId — same pattern as deviceTypeCatalog.routes.test.ts
class EchoAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'u1', username: 'test', email: 'test@t.com', role: 'admin' as const },
      cookieValue: 'u1',
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

const AUTH_COOKIE = 'auth_token=u1';

async function buildApp(perms: { read?: boolean; manage?: boolean } = { read: true, manage: true }) {
  const repo = new InMemoryMaterialCatalogRepository();
  const service = new MaterialCatalogService(repo);
  const listUC = new ListMaterial(repo);
  const getUC = new GetMaterial(repo);
  const createUC = new CreateMaterial(repo);
  const updateUC = new UpdateMaterial(repo);
  const deleteUC = new DeleteMaterial(repo);

  const requirePerm = (_mod: RbacModuleCode, act: PermissionAction): RequestHandler => {
    if (act === 'read') return perms.read !== false ? ((_r, _s, n) => n()) : ((_r, s) => s.status(403).json({ code: 'FORBIDDEN' }));
    if (act === 'manage') return perms.manage !== false ? ((_r, _s, n) => n()) : ((_r, s) => s.status(403).json({ code: 'FORBIDDEN' }));
    return (_r, _s, n) => n();
  };

  const router = createMaterialTypeCatalogRouter(
    new EchoAuthProvider(),
    undefined,
    requirePerm,
    listUC, getUC, createUC, updateUC, deleteUC,
    service,
  );

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/inventory', router);
  app.use(errorHandler);
  return { app, repo, service };
}

/** Helper: add auth cookie to all requests */
function authed(req: request.Test): request.Test {
  return req.set('Cookie', AUTH_COOKIE);
}

describe('materialTypeCatalog routes', () => {
  describe('GET /api/inventory/material-types', () => {
    it('returns all material types', async () => {
      const { app, repo } = await buildApp();
      await repo.create({ name: 'CABLE_UTP', unit: 'm', active: true, sortOrder: 0 });
      const res = await authed(request(app).get('/api/inventory/material-types'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('CABLE_UTP');
    });

    it('returns 403 without read permission', async () => {
      const { app } = await buildApp({ read: false, manage: true });
      const res = await authed(request(app).get('/api/inventory/material-types'));
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/inventory/material-types/:id', () => {
    it('returns a specific material type', async () => {
      const { app, repo } = await buildApp();
      const mat = await repo.create({ name: 'PRECINTO', unit: 'unidad', active: true, sortOrder: 0 });
      const res = await authed(request(app).get(`/api/inventory/material-types/${mat.id}`));
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('PRECINTO');
      expect(res.body.unit).toBe('unidad');
    });

    it('returns 404 for unknown id', async () => {
      const { app } = await buildApp();
      const res = await authed(request(app).get('/api/inventory/material-types/nonexistent'));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MATERIAL_NOT_FOUND');
    });
  });

  describe('POST /api/inventory/material-types', () => {
    it('creates a new material type → 201', async () => {
      const { app } = await buildApp();
      const res = await authed(request(app).post('/api/inventory/material-types').send({
        name: 'roseta', unit: 'unidad', active: true, sortOrder: 5,
      }));
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('ROSETA'); // normalized to UPPERCASE
      expect(res.body.unit).toBe('unidad');
    });

    it('returns 400 for invalid body', async () => {
      const { app } = await buildApp();
      const res = await authed(request(app).post('/api/inventory/material-types').send({ name: '' }));
      expect(res.status).toBe(400);
    });

    it('returns 409 for duplicate name', async () => {
      const { app, repo } = await buildApp();
      await repo.create({ name: 'CABLE_UTP', unit: 'm', active: true, sortOrder: 0 });
      const res = await authed(request(app).post('/api/inventory/material-types').send({ name: 'cable_utp' }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MATERIAL_NAME_CONFLICT');
    });

    it('returns 403 without manage permission', async () => {
      const { app } = await buildApp({ read: true, manage: false });
      const res = await authed(request(app).post('/api/inventory/material-types').send({ name: 'test' }));
      expect(res.status).toBe(403);
    });

    it('invalidates service cache after create', async () => {
      const { app, service } = await buildApp();
      await service.ensure(); // populate cache
      await authed(request(app).post('/api/inventory/material-types').send({ name: 'NUEVO', unit: 'm' }));
      // After invalidation, next ensure() would re-load — just confirm no error
      const names = await service.ensure();
      expect(names.has('NUEVO')).toBe(true);
    });
  });

  describe('PUT /api/inventory/material-types/:id', () => {
    it('updates an existing material type → 200', async () => {
      const { app, repo } = await buildApp();
      const mat = await repo.create({ name: 'CABLE_UTP', unit: 'm', active: true, sortOrder: 0 });
      const res = await authed(request(app).put(`/api/inventory/material-types/${mat.id}`).send({ label: 'Cable UTP Cat6' }));
      expect(res.status).toBe(200);
    });

    it('returns 404 for unknown id', async () => {
      const { app } = await buildApp();
      const res = await authed(request(app).put('/api/inventory/material-types/nonexistent').send({ label: 'x' }));
      expect(res.status).toBe(404);
    });

    it('returns 409 for conflicting name', async () => {
      const { app, repo } = await buildApp();
      await repo.create({ name: 'CABLE_UTP', unit: 'm', active: true, sortOrder: 0 });
      const mat2 = await repo.create({ name: 'CONECTOR', unit: 'unidad', active: true, sortOrder: 1 });
      const res = await authed(request(app).put(`/api/inventory/material-types/${mat2.id}`).send({ name: 'cable_utp' }));
      expect(res.status).toBe(409);
    });

    it('FIX-5a: use case throws InvalidMinStockError → 400 INVALID_MIN_STOCK (not 500)', async () => {
      // Bypass Zod by injecting an UpdateMaterial that always throws InvalidMinStockError.
      // This simulates the scenario where the error reaches the route handler unhandled.
      const repo = new InMemoryMaterialCatalogRepository();
      const service = new MaterialCatalogService(repo);
      const mat = await repo.create({ name: 'CABLE_UTP', unit: 'm', active: true, sortOrder: 0 });

      // Stub UpdateMaterial to always throw InvalidMinStockError
      const stubUpdate = {
        execute: async (_id: string, _data: unknown) => { throw new InvalidMinStockError(-1); },
      } as unknown as UpdateMaterial;

      const requirePerm = (_mod: RbacModuleCode, _act: PermissionAction): RequestHandler =>
        (_r, _s, n) => n();

      const router = createMaterialTypeCatalogRouter(
        new EchoAuthProvider(),
        undefined,
        requirePerm,
        new ListMaterial(repo),
        new GetMaterial(repo),
        new CreateMaterial(repo),
        stubUpdate,
        new DeleteMaterial(repo),
        service,
      );
      const app = express();
      app.use(cookieParser());
      app.use(express.json());
      app.use('/api/inventory', router);
      app.use(errorHandler);

      const res = await authed(request(app).put(`/api/inventory/material-types/${mat.id}`).send({ label: 'test' }));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_MIN_STOCK');
    });
  });

  describe('DELETE /api/inventory/material-types/:id', () => {
    it('deletes a material type → 204', async () => {
      const { app, repo } = await buildApp();
      const mat = await repo.create({ name: 'CABLE_UTP', unit: 'm', active: true, sortOrder: 0 });
      const res = await authed(request(app).delete(`/api/inventory/material-types/${mat.id}`));
      expect(res.status).toBe(204);
    });

    it('returns 404 for unknown id', async () => {
      const { app } = await buildApp();
      const res = await authed(request(app).delete('/api/inventory/material-types/nonexistent'));
      expect(res.status).toBe(404);
    });

    it('returns 409 for in-use material', async () => {
      const { app, repo } = await buildApp();
      const mat = await repo.create({ name: 'CABLE_UTP', unit: 'm', active: true, sortOrder: 0 });
      repo.usageCounts[mat.id] = 1;
      const res = await authed(request(app).delete(`/api/inventory/material-types/${mat.id}`));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MATERIAL_IN_USE');
    });

    it('returns 409 for protected OTRO material', async () => {
      const { app, repo } = await buildApp();
      await repo.create({ name: 'OTRO', unit: 'unidad', active: true, sortOrder: 0 });
      const mat = (await repo.getByName('OTRO'))!;
      const res = await authed(request(app).delete(`/api/inventory/material-types/${mat.id}`));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MATERIAL_PROTECTED');
    });
  });
});

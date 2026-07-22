/**
 * bulk-task-recipients (B3.3, TSC-3, TSC-4, D6) — /api/messaging/config/task-stages
 * router (supertest, in-memory). Molde `nocBroadcast.routes.test.ts`.
 *  - GET / → { stages: MappedStage[] }, gate messaging:read
 *  - PUT / → body { stageIds: string[] } Zod, gate messaging:manage
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { createTaskStageConfigRouter } from '@infrastructure/http/routes/taskStageConfig.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { InMemoryTaskStageRecipientConfigRepository, StageCatalogEntry } from '@infrastructure/adapters/in-memory/InMemoryTaskStageRecipientConfigRepository';
import { GetTaskStageRecipientConfig } from '@application/use-cases/GetTaskStageRecipientConfig';
import { UpdateTaskStageRecipientConfig } from '@application/use-cases/UpdateTaskStageRecipientConfig';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacPermission } from '@domain/entities/rbac';

const AUTH_COOKIE = 'auth_token=fake';

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

const grant: RequestHandler = (_req, _res, next) => next();
const deny: RequestHandler = (_req: Request, res: Response, _next: NextFunction) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};

/**
 * Fake narrow — `requirePermission` solo llama `listRolesForUser` +
 * `listPermissionsForUser` (ver su código fuente); el resto de
 * `RbacUserRepository` no se ejerce en este test de ROUTER, así que un cast
 * cubre el contrato sin implementar los 9 métodos CRUD no usados.
 */
function fakeRbacUserRepo(permissions: RbacPermission[]): RbacUserRepository {
  return {
    listRolesForUser: async () => [],
    listPermissionsForUser: async () => permissions,
  } as unknown as RbacUserRepository;
}

const catalog: Record<string, StageCatalogEntry> = {
  s1: { name: 'Instalación pendiente', code: 'PEND', color: '#fff', workflowId: 'w1', workflowName: 'Instalaciones' },
  s2: { name: 'En proceso', code: 'PROC', color: '#000', workflowId: 'w1', workflowName: 'Instalaciones' },
};

function buildApp(opts?: { read?: RequestHandler; manage?: RequestHandler; initialMapped?: string[] }) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const configRepo = new InMemoryTaskStageRecipientConfigRepository(catalog, opts?.initialMapped ?? []);

  app.use(
    '/api/messaging/config/task-stages',
    createTaskStageConfigRouter(
      new FakeAuthProvider(),
      { read: opts?.read ?? grant, manage: opts?.manage ?? grant },
      new GetTaskStageRecipientConfig(configRepo),
      new UpdateTaskStageRecipientConfig(configRepo),
    ),
  );
  app.use(errorHandler);
  return { app, configRepo };
}

describe('taskStageConfig.routes — GET /', () => {
  it('usuario con messaging.read → 200 con los stages mapeados hidratados (TSC-3 scenario 1)', async () => {
    const { app } = buildApp({ initialMapped: ['s1'] });
    const res = await request(app).get('/api/messaging/config/task-stages').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      stages: [{ stageId: 's1', stageName: 'Instalación pendiente', stageCode: 'PEND', color: '#fff', workflowId: 'w1', workflowName: 'Instalaciones' }],
    });
  });

  it('config vacía (0 stages mapeados) → 200 { stages: [] }, no error', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/config/task-stages').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stages: [] });
  });

  it('sin auth cookie → 401', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/config/task-stages');
    expect(res.status).toBe(401);
  });

  it('GET denegado por el gate messaging:read → 403 PERMISSION_DENIED', async () => {
    const { app } = buildApp({ read: deny });
    const res = await request(app).get('/api/messaging/config/task-stages').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('TSC-3 scenario 2: rol custom con messaging.bulk pero SIN messaging.read → 403 vía el gate REAL requirePermission (esperado, NO bug — desvío #1 de tasks.md)', async () => {
    const userRepo = fakeRbacUserRepo([{ id: 'p1', moduleCode: 'messaging', action: 'bulk' }]);
    const { app } = buildApp({ read: requirePermission(userRepo, 'messaging', 'read') });
    const res = await request(app).get('/api/messaging/config/task-stages').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });
});

describe('taskStageConfig.routes — PUT /', () => {
  it('replace-set exitoso: body {stageIds:["s1","s2"]}, ambos existentes → 200, config queda [s1,s2] EXACTAMENTE (TSC-4)', async () => {
    const { app, configRepo } = buildApp({ initialMapped: ['s1'] });
    const res = await request(app)
      .put('/api/messaging/config/task-stages')
      .set('Cookie', AUTH_COOKIE)
      .send({ stageIds: ['s1', 's2'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      stages: [
        { stageId: 's1', stageName: 'Instalación pendiente', stageCode: 'PEND', color: '#fff', workflowId: 'w1', workflowName: 'Instalaciones' },
        { stageId: 's2', stageName: 'En proceso', stageCode: 'PROC', color: '#000', workflowId: 'w1', workflowName: 'Instalaciones' },
      ],
    });
    expect(await configRepo.listMappedStageIds()).toEqual(['s1', 's2']);
  });

  it('payload malformado {stageIds:"no-es-array"} → 400 VALIDATION_ERROR, config sin cambios', async () => {
    const { app, configRepo } = buildApp({ initialMapped: ['s1'] });
    const res = await request(app)
      .put('/api/messaging/config/task-stages')
      .set('Cookie', AUTH_COOKIE)
      .send({ stageIds: 'no-es-array' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await configRepo.listMappedStageIds()).toEqual(['s1']);
  });

  it('stageId inexistente → error tipado mapeado a 422 TASK_STAGE_NOT_FOUND, config previa intacta (TSC-4 "rechazado, nada se aplica")', async () => {
    const { app, configRepo } = buildApp({ initialMapped: ['s1'] });
    const res = await request(app)
      .put('/api/messaging/config/task-stages')
      .set('Cookie', AUTH_COOKIE)
      .send({ stageIds: ['s1', 'stage-inexistente'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TASK_STAGE_NOT_FOUND');
    expect(await configRepo.listMappedStageIds()).toEqual(['s1']);
  });

  it('usuario con messaging.read pero SIN messaging.manage → 403 (manage es estrictamente más restrictivo, TSC-4)', async () => {
    const { app } = buildApp({ manage: deny });
    const res = await request(app)
      .put('/api/messaging/config/task-stages')
      .set('Cookie', AUTH_COOKIE)
      .send({ stageIds: ['s1'] });
    expect(res.status).toBe(403);
  });
});

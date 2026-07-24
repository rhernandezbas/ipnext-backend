/**
 * bulk-task-recipients (B3.3) + bulk-task-stage-transition (TTC-4, B1.7) —
 * /api/messaging/config/task-stages router (supertest, in-memory).
 *  - GET / → { stages, resultingStage }, gate messaging:read
 *  - PUT / → body { stageIds: string[] } Zod, gate messaging:manage
 *  - PUT /resulting-stage → body { stageId: string|null } Zod, gate messaging:manage,
 *    valida existencia (422 TASK_STAGE_NOT_FOUND) + prohíbe send_to_iclass (422 RESULTING_STAGE_NOT_ALLOWED)
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { createTaskStageConfigRouter } from '@infrastructure/http/routes/taskStageConfig.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { InMemoryTaskStageRecipientConfigRepository, StageCatalogEntry } from '@infrastructure/adapters/in-memory/InMemoryTaskStageRecipientConfigRepository';
import { InMemoryTaskStageTransitionConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskStageTransitionConfigRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { GetTaskStageRecipientConfig } from '@application/use-cases/GetTaskStageRecipientConfig';
import { UpdateTaskStageRecipientConfig } from '@application/use-cases/UpdateTaskStageRecipientConfig';
import { GetTaskStageTransitionConfig } from '@application/use-cases/GetTaskStageTransitionConfig';
import { SetTaskStageTransitionConfig } from '@application/use-cases/SetTaskStageTransitionConfig';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacPermission } from '@domain/entities/rbac';
import type { Stage } from '@domain/entities/workflow';

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

function fakeRbacUserRepo(permissions: RbacPermission[]): RbacUserRepository {
  return {
    listRolesForUser: async () => [],
    listPermissionsForUser: async () => permissions,
  } as unknown as RbacUserRepository;
}

const catalog: Record<string, StageCatalogEntry> = {
  s1: { name: 'Instalación pendiente', code: 'PEND', color: '#fff', workflowId: 'w1', workflowName: 'Instalaciones' },
  s2: { name: 'En proceso', code: 'PROC', color: '#000', workflowId: 'w1', workflowName: 'Instalaciones' },
  sIclass: { name: 'Enviar a IClass', code: 'send_to_iclass', color: null, workflowId: 'w1', workflowName: 'Instalaciones' },
};

const stageRows: Stage[] = [
  { id: 's1', workflowId: 'w1', name: 'Instalación pendiente', code: 'PEND', category: 'nuevo', order: 1, color: '#fff' },
  { id: 's2', workflowId: 'w1', name: 'En proceso', code: 'PROC', category: 'enProgreso', order: 2, color: '#000' },
  { id: 'sIclass', workflowId: 'w1', name: 'Enviar a IClass', code: 'send_to_iclass', category: 'enProgreso', order: 3, color: null },
];

function buildApp(opts?: { read?: RequestHandler; manage?: RequestHandler; initialMapped?: string[]; initialResulting?: string | null }) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const configRepo = new InMemoryTaskStageRecipientConfigRepository(catalog, opts?.initialMapped ?? []);
  const transitionRepo = new InMemoryTaskStageTransitionConfigRepository(catalog, opts?.initialResulting ?? null);
  const stageRepo = new InMemoryStageRepository();
  stageRows.forEach((s) => stageRepo.addDirect(s));

  app.use(
    '/api/messaging/config/task-stages',
    createTaskStageConfigRouter(
      new FakeAuthProvider(),
      { read: opts?.read ?? grant, manage: opts?.manage ?? grant },
      new GetTaskStageRecipientConfig(configRepo),
      new UpdateTaskStageRecipientConfig(configRepo),
      new GetTaskStageTransitionConfig(transitionRepo),
      new SetTaskStageTransitionConfig(transitionRepo, stageRepo),
    ),
  );
  app.use(errorHandler);
  return { app, configRepo, transitionRepo };
}

describe('taskStageConfig.routes — GET /', () => {
  it('200 con stages mapeados + resultingStage (TTC-4)', async () => {
    const { app } = buildApp({ initialMapped: ['s1'], initialResulting: 's2' });
    const res = await request(app).get('/api/messaging/config/task-stages').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      stages: [{ stageId: 's1', stageName: 'Instalación pendiente', stageCode: 'PEND', color: '#fff', workflowId: 'w1', workflowName: 'Instalaciones' }],
      resultingStage: { stageId: 's2', stageName: 'En proceso', stageCode: 'PROC', color: '#000', workflowId: 'w1', workflowName: 'Instalaciones' },
    });
  });

  it('config vacía → 200 { stages: [], resultingStage: null }', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/messaging/config/task-stages').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stages: [], resultingStage: null });
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

  it('rol custom con messaging.bulk pero SIN messaging.read → 403 vía requirePermission REAL', async () => {
    const userRepo = fakeRbacUserRepo([{ id: 'p1', moduleCode: 'messaging', action: 'bulk' }]);
    const { app } = buildApp({ read: requirePermission(userRepo, 'messaging', 'read') });
    const res = await request(app).get('/api/messaging/config/task-stages').set('Cookie', AUTH_COOKIE);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });
});

describe('taskStageConfig.routes — PUT / (elegibles)', () => {
  it('replace-set exitoso → 200, config queda [s1,s2]', async () => {
    const { app, configRepo } = buildApp({ initialMapped: ['s1'] });
    const res = await request(app).put('/api/messaging/config/task-stages').set('Cookie', AUTH_COOKIE).send({ stageIds: ['s1', 's2'] });
    expect(res.status).toBe(200);
    expect(await configRepo.listMappedStageIds()).toEqual(['s1', 's2']);
  });

  it('payload malformado → 400 VALIDATION_ERROR, config sin cambios', async () => {
    const { app, configRepo } = buildApp({ initialMapped: ['s1'] });
    const res = await request(app).put('/api/messaging/config/task-stages').set('Cookie', AUTH_COOKIE).send({ stageIds: 'no-es-array' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await configRepo.listMappedStageIds()).toEqual(['s1']);
  });

  it('stageId inexistente → 422 TASK_STAGE_NOT_FOUND, config intacta', async () => {
    const { app, configRepo } = buildApp({ initialMapped: ['s1'] });
    const res = await request(app).put('/api/messaging/config/task-stages').set('Cookie', AUTH_COOKIE).send({ stageIds: ['s1', 'stage-inexistente'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TASK_STAGE_NOT_FOUND');
    expect(await configRepo.listMappedStageIds()).toEqual(['s1']);
  });

  it('sin messaging.manage → 403', async () => {
    const { app } = buildApp({ manage: deny });
    const res = await request(app).put('/api/messaging/config/task-stages').set('Cookie', AUTH_COOKIE).send({ stageIds: ['s1'] });
    expect(res.status).toBe(403);
  });
});

describe('taskStageConfig.routes — PUT /resulting-stage (TTC-4)', () => {
  it('set exitoso → 200, resultingStage queda seteado', async () => {
    const { app, transitionRepo } = buildApp();
    const res = await request(app).put('/api/messaging/config/task-stages/resulting-stage').set('Cookie', AUTH_COOKIE).send({ stageId: 's2' });
    expect(res.status).toBe(200);
    expect(res.body.resultingStage.stageId).toBe('s2');
    expect(await transitionRepo.getResultingStageId()).toBe('s2');
  });

  it('null → 200, limpia el destino', async () => {
    const { app, transitionRepo } = buildApp({ initialResulting: 's2' });
    const res = await request(app).put('/api/messaging/config/task-stages/resulting-stage').set('Cookie', AUTH_COOKIE).send({ stageId: null });
    expect(res.status).toBe(200);
    expect(res.body.resultingStage).toBeNull();
    expect(await transitionRepo.getResultingStageId()).toBeNull();
  });

  it('send_to_iclass → 422 RESULTING_STAGE_NOT_ALLOWED, config intacta (decisión 7)', async () => {
    const { app, transitionRepo } = buildApp({ initialResulting: 's2' });
    const res = await request(app).put('/api/messaging/config/task-stages/resulting-stage').set('Cookie', AUTH_COOKIE).send({ stageId: 'sIclass' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RESULTING_STAGE_NOT_ALLOWED');
    expect(await transitionRepo.getResultingStageId()).toBe('s2');
  });

  it('stageId inexistente → 422 TASK_STAGE_NOT_FOUND, config intacta', async () => {
    const { app, transitionRepo } = buildApp({ initialResulting: 's2' });
    const res = await request(app).put('/api/messaging/config/task-stages/resulting-stage').set('Cookie', AUTH_COOKIE).send({ stageId: 'ghost' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TASK_STAGE_NOT_FOUND');
    expect(await transitionRepo.getResultingStageId()).toBe('s2');
  });

  it('payload malformado (stageId numérico) → 400 VALIDATION_ERROR', async () => {
    const { app } = buildApp();
    const res = await request(app).put('/api/messaging/config/task-stages/resulting-stage').set('Cookie', AUTH_COOKIE).send({ stageId: 123 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('sin messaging.manage → 403', async () => {
    const { app } = buildApp({ manage: deny });
    const res = await request(app).put('/api/messaging/config/task-stages/resulting-stage').set('Cookie', AUTH_COOKIE).send({ stageId: 's2' });
    expect(res.status).toBe(403);
  });
});

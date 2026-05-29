import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryIClassResultCodeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemorySyncStateRepository } from '../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { SyncIClassResultCodes } from '../../application/use-cases/SyncIClassResultCodes';
import { ListIClassResultCodes } from '../../application/use-cases/ListIClassResultCodes';
import { AssignResultCodeStage } from '../../application/use-cases/AssignResultCodeStage';
import { GetClosureStatus } from '../../application/use-cases/GetClosureStatus';
import { createIClassClosureRouter } from '../../infrastructure/http/routes/iclass-closure.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { IClassPort, IClassResultCodeDescriptor } from '../../domain/ports/IClassPort';
import { StageRepository } from '../../domain/ports/StageRepository';
import { Stage } from '../../domain/entities/workflow';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';

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

const STAGE: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', category: 'hecho', order: 8, color: null };
function fakeStages(known: Record<string, Stage>): StageRepository {
  return { getById: async (id: string) => known[id] ?? null } as unknown as StageRepository;
}
function fakeIClass(codes: IClassResultCodeDescriptor[]): IClassPort {
  return { listResultCodes: async () => codes } as unknown as IClassPort;
}

function buildApp() {
  const repo = new InMemoryIClassResultCodeRepository();
  const state = new InMemorySyncStateRepository();
  const iclass = fakeIClass([
    { soTypeId: '1', code: 'Instalacion Completa Fibra', type: 'Sucesso' },
    { soTypeId: '1', code: 'Cliente Ausente', type: 'Pendente' },
  ]);
  const router = createIClassClosureRouter(
    new SyncIClassResultCodes(iclass, repo),
    new ListIClassResultCodes(repo),
    new AssignResultCodeStage(repo, fakeStages({ [STAGE.id]: STAGE })),
    new GetClosureStatus(state),
    new FakeAuthProvider(),
  );
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin/iclass', router);
  app.use(errorHandler);
  return { app, repo };
}

const AUTH = ['Cookie', 'auth_token=fake'] as const;

describe('IClass closure routes', () => {
  it('POST /result-codes/sync syncs the catalog', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/admin/iclass/result-codes/sync').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(2);
  });

  it('401 without auth', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/api/admin/iclass/result-codes')).status).toBe(401);
  });

  it('GET /result-codes lists the catalog with mapping fields', async () => {
    const { app } = buildApp();
    await request(app).post('/api/admin/iclass/result-codes/sync').set(...AUTH);
    const res = await request(app).get('/api/admin/iclass/result-codes').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toHaveProperty('mappedStageId');
  });

  it('PATCH /result-codes/:id assigns a stage (the configurable mapping)', async () => {
    const { app, repo } = buildApp();
    await request(app).post('/api/admin/iclass/result-codes/sync').set(...AUTH);
    const rc = (await repo.list())[0];
    const res = await request(app).patch(`/api/admin/iclass/result-codes/${rc.id}`).set(...AUTH).send({ stageId: STAGE.id });
    expect(res.status).toBe(200);
    expect(res.body.mappedStageId).toBe(STAGE.id);
  });

  it('PATCH with a ghost stage → 404 STAGE_NOT_FOUND', async () => {
    const { app, repo } = buildApp();
    await request(app).post('/api/admin/iclass/result-codes/sync').set(...AUTH);
    const rc = (await repo.list())[0];
    const res = await request(app).patch(`/api/admin/iclass/result-codes/${rc.id}`).set(...AUTH).send({ stageId: 'ghost' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('STAGE_NOT_FOUND');
  });

  it('PATCH a ghost result code → 404 ICLASS_RESULT_CODE_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app).patch('/api/admin/iclass/result-codes/ghost').set(...AUTH).send({ stageId: STAGE.id });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ICLASS_RESULT_CODE_NOT_FOUND');
  });

  it('PATCH with an invalid body → 400 VALIDATION_ERROR', async () => {
    const { app, repo } = buildApp();
    await request(app).post('/api/admin/iclass/result-codes/sync').set(...AUTH);
    const rc = (await repo.list())[0];
    const res = await request(app).patch(`/api/admin/iclass/result-codes/${rc.id}`).set(...AUTH).send({ stageId: 123 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET /closure/status returns null + zero counts before any run', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/iclass/closure/status').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.lastRunAt).toBeNull();
    expect(res.body.counts.mirrored).toBe(0);
  });
});

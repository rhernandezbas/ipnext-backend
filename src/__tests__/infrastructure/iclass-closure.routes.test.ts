import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryIClassResultCodeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemorySyncStateRepository } from '../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { SyncIClassResultCodes } from '../../application/use-cases/SyncIClassResultCodes';
import { ListIClassResultCodes } from '../../application/use-cases/ListIClassResultCodes';
import { AssignResultCodeStage } from '../../application/use-cases/AssignResultCodeStage';
import { GetClosureStatus } from '../../application/use-cases/GetClosureStatus';
import { GetPendingSideEffectsCount } from '../../application/use-cases/GetPendingSideEffectsCount';
import { GetPendingSideEffectsList } from '../../application/use-cases/GetPendingSideEffectsList';
import { createIClassClosureRouter } from '../../infrastructure/http/routes/iclass-closure.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { IClassPort, IClassResultCodeDescriptor } from '../../domain/ports/IClassPort';
import { StageRepository } from '../../domain/ports/StageRepository';
import { Stage } from '../../domain/entities/workflow';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import type { TriggerResult } from '../../infrastructure/scheduling/TaskAutocompleteScheduler';
import { InMemoryClosedServiceOrderRepository } from '../../infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';

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

const STAGE: Stage = { id: 'st-inst', workflowId: 'wf', name: 'Instalado', code: 'instalado', category: 'hecho', order: 8, color: null };
function fakeStages(known: Record<string, Stage>): StageRepository {
  return { getById: async (id: string) => known[id] ?? null } as unknown as StageRepository;
}
function fakeIClass(codes: IClassResultCodeDescriptor[]): IClassPort {
  return { listResultCodes: async () => codes } as unknown as IClassPort;
}

/** Stub del scheduler con resultado configurable en triggerNow */
function schedulerStub(result: TriggerResult) {
  return { triggerNow: async () => result } as never;
}

function buildApp(
  schedulerResult: TriggerResult = { queued: true },
  closedRepo?: InMemoryClosedServiceOrderRepository,
  requireIClassManageOverride?: (req: unknown, res: unknown, next: () => void) => void,
) {
  const repo = new InMemoryIClassResultCodeRepository();
  const state = new InMemorySyncStateRepository();
  const closed = closedRepo ?? new InMemoryClosedServiceOrderRepository();
  const iclass = fakeIClass([
    { soTypeId: '1', code: 'Instalacion Completa Fibra', type: 'Sucesso' },
    { soTypeId: '1', code: 'Cliente Ausente', type: 'Pendente' },
  ]);
  const backfill = { execute: async () => ({ mirrored: 2, transitioned: 2, skippedNotClosed: 0, skippedNotOurs: 0, skippedUnchanged: 0 }) };
  const scheduler = schedulerStub(schedulerResult);
  const getPendingCount = new GetPendingSideEffectsCount(closed);
  const getPendingList = new GetPendingSideEffectsList(closed);
  const requireIClassManage = requireIClassManageOverride
    ?? ((_req: unknown, _res: unknown, next: () => void) => next());
  const router = createIClassClosureRouter(
    new SyncIClassResultCodes(iclass, repo),
    new ListIClassResultCodes(repo),
    new AssignResultCodeStage(repo, fakeStages({ [STAGE.id]: STAGE })),
    new GetClosureStatus(state),
    backfill as never,
    scheduler,
    getPendingCount,
    getPendingList,
    requireIClassManage as never,
    new FakeAuthProvider(),
  );
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin/iclass', router);
  app.use(errorHandler);
  return { app, repo };
}

/** Construye una app con scheduler=null para probar el 503 */
function buildAppNullScheduler() {
  const repo = new InMemoryIClassResultCodeRepository();
  const state = new InMemorySyncStateRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const iclass = fakeIClass([]);
  const backfill = { execute: async () => ({ mirrored: 0, transitioned: 0, skippedNotClosed: 0, skippedNotOurs: 0, skippedUnchanged: 0 }) };
  const getPendingCount = new GetPendingSideEffectsCount(closed);
  const getPendingList = new GetPendingSideEffectsList(closed);
  const router = createIClassClosureRouter(
    new SyncIClassResultCodes(iclass, repo),
    new ListIClassResultCodes(repo),
    new AssignResultCodeStage(repo, fakeStages({})),
    new GetClosureStatus(state),
    backfill as never,
    null, // scheduler null → 503
    getPendingCount,
    getPendingList,
    ((_req: unknown, _res: unknown, next: () => void) => next()) as never,
    new FakeAuthProvider(),
  );
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin/iclass', router);
  app.use(errorHandler);
  return { app };
}

const AUTH = ['Cookie', 'auth_token=fake'] as const;

describe('IClass closure routes', () => {
  // -----------------------------------------------------------------------
  // REQ-REPROCESS-1: POST /closure/reprocess → 202 (async dispatch)
  // -----------------------------------------------------------------------

  it('POST /closure/reprocess → 202 {queued:true} when dispatch succeeds', async () => {
    const { app } = buildApp({ queued: true });
    const res = await request(app).post('/api/admin/iclass/closure/reprocess').set(...AUTH);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
  });

  it('POST /closure/reprocess → 202 {queued:false, reason:"already-running"} when in flight', async () => {
    const { app } = buildApp({ queued: false, reason: 'already-running' });
    const res = await request(app).post('/api/admin/iclass/closure/reprocess').set(...AUTH);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: false, reason: 'already-running' });
  });

  it('POST /closure/reprocess → 202 {queued:false, reason:"flag-disabled"} when flag OFF', async () => {
    const { app } = buildApp({ queued: false, reason: 'flag-disabled' });
    const res = await request(app).post('/api/admin/iclass/closure/reprocess').set(...AUTH);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: false, reason: 'flag-disabled' });
  });

  it('POST /closure/reprocess → 503 when scheduler is null', async () => {
    const { app } = buildAppNullScheduler();
    const res = await request(app).post('/api/admin/iclass/closure/reprocess').set(...AUTH);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ reason: 'unavailable' });
  });

  it('POST /closure/reprocess → 401 without auth', async () => {
    const { app } = buildApp();
    expect((await request(app).post('/api/admin/iclass/closure/reprocess')).status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // REQ-PENDING-COUNT-1: GET /closure/reprocess/pending-count → 200 {pending}
  // -----------------------------------------------------------------------

  it('GET /closure/reprocess/pending-count → 200 {pending:2} when two SOs pending', async () => {
    const closed = new InMemoryClosedServiceOrderRepository();
    // Insertar SOs con side-effects pendientes (estado fresh = todo pendiente)
    await closed.upsert(makeSO('so-1'), 'task-1');
    await closed.upsert(makeSO('so-2'), 'task-2');
    const { app } = buildApp({ queued: true }, closed);
    const res = await request(app).get('/api/admin/iclass/closure/reprocess/pending-count').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: 2 });
  });

  it('GET /closure/reprocess/pending-count → 200 {pending:0} when no SOs pending', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/iclass/closure/reprocess/pending-count').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending: 0 });
  });

  it('GET /closure/reprocess/pending-count → 401 without auth', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/api/admin/iclass/closure/reprocess/pending-count')).status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Rutas existentes — no deben regresar
  // -----------------------------------------------------------------------

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

  it('POST /closure/backfill runs the reconcile and returns counts', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/admin/iclass/closure/backfill').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.mirrored).toBe(2);
    expect(res.body.transitioned).toBe(2);
  });

  it('POST /closure/backfill is 401 without auth', async () => {
    const { app } = buildApp();
    expect((await request(app).post('/api/admin/iclass/closure/backfill')).status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // REQ-LIST-1 SC1–SC5: GET /closure/reprocess/pending-list
  // -----------------------------------------------------------------------

  it('GET /closure/reprocess/pending-list → 200 {items:[3 SOs],total:3} (SC1)', async () => {
    const tasks = new Map([
      ['t-1', { id: 't-1', sequenceNumber: 1, title: 'Task 1' }],
      ['t-2', { id: 't-2', sequenceNumber: 2, title: 'Task 2' }],
      ['t-3', { id: 't-3', sequenceNumber: 3, title: 'Task 3' }],
    ]);
    const closed = new InMemoryClosedServiceOrderRepository(tasks);
    await closed.upsert(makeSO('so-1'), 't-1');
    await closed.upsert(makeSO('so-2'), 't-2');
    await closed.upsert(makeSO('so-3'), 't-3');
    const { app } = buildApp({ queued: true }, closed);
    const res = await request(app).get('/api/admin/iclass/closure/reprocess/pending-list').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items[0]).toHaveProperty('iclassId');
    expect(res.body.items[0]).toHaveProperty('task');
    expect(res.body.items[0].task).not.toBeNull();
  });

  it('GET /closure/reprocess/pending-list → 200 {items:[],total:0} when nothing pending (SC3)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/iclass/closure/reprocess/pending-list').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
  });

  it('GET /closure/reprocess/pending-list → item with task:null when SO has no linked task (SC2)', async () => {
    const closed = new InMemoryClosedServiceOrderRepository();
    await closed.upsert(makeSO('so-orphan'), null);
    const { app } = buildApp({ queued: true }, closed);
    const res = await request(app).get('/api/admin/iclass/closure/reprocess/pending-list').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].scheduledTaskId).toBeNull();
    expect(res.body.items[0].task).toBeNull();
  });

  it('GET /closure/reprocess/pending-list → 401 without auth (SC4)', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/api/admin/iclass/closure/reprocess/pending-list')).status).toBe(401);
  });

  it('GET /closure/reprocess/pending-list → 403 when requireIClassManage rejects (SC5)', async () => {
    const rejectMiddleware = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => {
      res.status(403).json({ code: 'FORBIDDEN' });
    };
    const { app } = buildApp({ queued: true }, undefined, rejectMiddleware as never);
    const res = await request(app).get('/api/admin/iclass/closure/reprocess/pending-list').set(...AUTH);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Helper local (no exportar — solo para tests)
// ---------------------------------------------------------------------------
import type { ClosedServiceOrder } from '../../domain/entities/iclass-closed-order';
function makeSO(iclassId: string): ClosedServiceOrder {
  return {
    iclassId,
    iclassCodigo: iclassId,
    iclassUpdatedAt: '2024-01-01',
    clusterName: 'cluster',
    thirdPartyCode: null, nodeCode: null, soTypeId: null, soTypeDescription: null,
    customerCode: null, customerName: null, addressCode: null, addressLine: null,
    addressCity: null, addressLat: null, addressLng: null,
    statusCode: '7', statusDescription: 'Encerrado',
    requestedAt: null, scheduledFor: null, availableAt: null,
    serviceStartedAt: null, serviceEndedAt: null,
    resultCodeName: null, closedByLogin: null, closedByName: null,
    closeLatitude: null, closeLongitude: null, closeGpsAt: null,
    billingAmount: null, technicianNote: null, internalNote: null, commentaryLog: null,
    teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
    iclassCreatedAt: null, rawDetail: {},
    closedAt: null, firstClosedAt: null, approvedAt: null, resultCodeType: null,
    history: [], checklists: [], materials: [], equipmentEvents: [],
  };
}

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { InMemoryIClassResultCodeRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassResultCodeRepository';
import { InMemorySyncStateRepository } from '../../infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { InMemoryIClassClosureConfigRepository } from '../../infrastructure/adapters/in-memory/InMemoryIClassClosureConfigRepository';
import { SyncIClassResultCodes } from '../../application/use-cases/SyncIClassResultCodes';
import { ListIClassResultCodes } from '../../application/use-cases/ListIClassResultCodes';
import { AssignResultCodeStage } from '../../application/use-cases/AssignResultCodeStage';
import { GetClosureStatus } from '../../application/use-cases/GetClosureStatus';
import { GetPendingSideEffectsCount } from '../../application/use-cases/GetPendingSideEffectsCount';
import { GetPendingSideEffectsList } from '../../application/use-cases/GetPendingSideEffectsList';
import { GetIClassClosureConfig } from '../../application/use-cases/GetIClassClosureConfig';
import { UpdateIClassClosureConfig } from '../../application/use-cases/UpdateIClassClosureConfig';
import { createIClassClosureRouter } from '../../infrastructure/http/routes/iclass-closure.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { IClassPort, IClassResultCodeDescriptor } from '../../domain/ports/IClassPort';
import { StageRepository } from '../../domain/ports/StageRepository';
import { Stage } from '../../domain/entities/workflow';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import type { TriggerResult } from '../../infrastructure/scheduling/TaskAutocompleteScheduler';
import type { BackfillTriggerResult } from '../../infrastructure/scheduling/BackfillScheduler';
import { InMemoryClosedServiceOrderRepository } from '../../infrastructure/adapters/in-memory/InMemoryClosedServiceOrderRepository';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryIClassClient } from '../../infrastructure/adapters/in-memory/InMemoryIClassClient';
import { IngestClosedServiceOrders } from '../../application/use-cases/IngestClosedServiceOrders';
import { BackfillClosedServiceOrders } from '../../application/use-cases/BackfillClosedServiceOrders';
import { ListInFlightTasks } from '../../application/use-cases/ListInFlightTasks';
import { ReconcileTaskClosure } from '../../application/use-cases/ReconcileTaskClosure';

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
const REGISTRADO: Stage = { id: 'st-reg', workflowId: 'wf', name: 'Registrado en IClass', code: 'registered_in_iclass', category: 'nuevo', order: 5, color: null };

/**
 * Construye las dos use cases de la página de reconcile (in-flight + per-task)
 * sobre un scheduling repo in-memory. Devuelve el repo para poder sembrar tareas.
 */
function buildReconcileUseCases() {
  const stages = new InMemoryStageRepository();
  stages.addDirect(REGISTRADO);
  stages.addDirect(STAGE);
  const scheduling = new InMemorySchedulingRepository(stages);
  const iclass = new InMemoryIClassClient();
  const rcRepo = new InMemoryIClassResultCodeRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const state = new InMemorySyncStateRepository();
  const ingest = new IngestClosedServiceOrders(iclass, closed, rcRepo, scheduling, state, { now: () => new Date('2026-05-29T12:00:00Z') });
  const backfill = new BackfillClosedServiceOrders(iclass, scheduling, ingest, { now: () => new Date('2026-05-29T12:00:00Z') });
  const listInFlight = new ListInFlightTasks(scheduling);
  const reconcile = new ReconcileTaskClosure(scheduling, backfill);
  return { scheduling, iclass, listInFlight, reconcile };
}
function fakeStages(known: Record<string, Stage>): StageRepository {
  return { getById: async (id: string) => known[id] ?? null } as unknown as StageRepository;
}
function fakeIClass(codes: IClassResultCodeDescriptor[]): IClassPort {
  return { listResultCodes: async () => codes } as unknown as IClassPort;
}

/** Stub del reprocess scheduler con resultado configurable en triggerNow */
function schedulerStub(result: TriggerResult) {
  return { triggerNow: async () => result } as never;
}

/** Stub del backfill scheduler con resultado configurable en triggerNow */
function backfillSchedulerStub(result: BackfillTriggerResult) {
  return { triggerNow: async () => result } as never;
}

function buildApp(
  schedulerResult: TriggerResult = { queued: true },
  closedRepo?: InMemoryClosedServiceOrderRepository,
  requireIClassManageOverride?: (req: unknown, res: unknown, next: () => void) => void,
  configRepo?: InMemoryIClassClosureConfigRepository,
  backfillResult: BackfillTriggerResult = { queued: true },
  reconcileUseCases = buildReconcileUseCases(),
) {
  const repo = new InMemoryIClassResultCodeRepository();
  const state = new InMemorySyncStateRepository();
  const closed = closedRepo ?? new InMemoryClosedServiceOrderRepository();
  const iclass = fakeIClass([
    { soTypeId: '1', code: 'Instalacion Completa Fibra', type: 'Sucesso' },
    { soTypeId: '1', code: 'Cliente Ausente', type: 'Pendente' },
  ]);
  const backfillSched = backfillSchedulerStub(backfillResult);
  const scheduler = schedulerStub(schedulerResult);
  const getPendingCount = new GetPendingSideEffectsCount(closed);
  const getPendingList = new GetPendingSideEffectsList(closed);
  const requireIClassManage = requireIClassManageOverride
    ?? ((_req: unknown, _res: unknown, next: () => void) => next());
  const cfgRepo = configRepo ?? new InMemoryIClassClosureConfigRepository();
  const getConfig = new GetIClassClosureConfig(cfgRepo);
  const updateConfig = new UpdateIClassClosureConfig(cfgRepo);
  const router = createIClassClosureRouter(
    new SyncIClassResultCodes(iclass, repo),
    new ListIClassResultCodes(repo),
    new AssignResultCodeStage(repo, fakeStages({ [STAGE.id]: STAGE })),
    new GetClosureStatus(state),
    backfillSched,
    scheduler,
    getPendingCount,
    getPendingList,
    getConfig,
    updateConfig,
    reconcileUseCases.listInFlight,
    reconcileUseCases.reconcile,
    requireIClassManage as never,
    new FakeAuthProvider(),
    undefined,
  );
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin/iclass', router);
  app.use(errorHandler);
  return { app, repo, cfgRepo, scheduling: reconcileUseCases.scheduling, iclass: reconcileUseCases.iclass };
}

/** Construye una app con reprocess scheduler=null para probar el 503 del reprocess */
function buildAppNullScheduler() {
  const repo = new InMemoryIClassResultCodeRepository();
  const state = new InMemorySyncStateRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const iclass = fakeIClass([]);
  const getPendingCount = new GetPendingSideEffectsCount(closed);
  const getPendingList = new GetPendingSideEffectsList(closed);
  const cfgRepo = new InMemoryIClassClosureConfigRepository();
  const getConfig = new GetIClassClosureConfig(cfgRepo);
  const updateConfig = new UpdateIClassClosureConfig(cfgRepo);
  const router = createIClassClosureRouter(
    new SyncIClassResultCodes(iclass, repo),
    new ListIClassResultCodes(repo),
    new AssignResultCodeStage(repo, fakeStages({})),
    new GetClosureStatus(state),
    backfillSchedulerStub({ queued: true }), // backfill scheduler presente
    null, // reprocess scheduler null → 503 para /reprocess
    getPendingCount,
    getPendingList,
    getConfig,
    updateConfig,
    buildReconcileUseCases().listInFlight,
    buildReconcileUseCases().reconcile,
    ((_req: unknown, _res: unknown, next: () => void) => next()) as never,
    new FakeAuthProvider(),
    undefined,
  );
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/admin/iclass', router);
  app.use(errorHandler);
  return { app };
}

/** Construye una app con backfill scheduler=null para probar el 503 del backfill */
function buildAppNullBackfillScheduler() {
  const repo = new InMemoryIClassResultCodeRepository();
  const state = new InMemorySyncStateRepository();
  const closed = new InMemoryClosedServiceOrderRepository();
  const iclass = fakeIClass([]);
  const getPendingCount = new GetPendingSideEffectsCount(closed);
  const getPendingList = new GetPendingSideEffectsList(closed);
  const cfgRepo = new InMemoryIClassClosureConfigRepository();
  const getConfig = new GetIClassClosureConfig(cfgRepo);
  const updateConfig = new UpdateIClassClosureConfig(cfgRepo);
  const router = createIClassClosureRouter(
    new SyncIClassResultCodes(iclass, repo),
    new ListIClassResultCodes(repo),
    new AssignResultCodeStage(repo, fakeStages({})),
    new GetClosureStatus(state),
    null, // backfill scheduler null → 503 para /backfill
    schedulerStub({ queued: true }), // reprocess scheduler presente
    getPendingCount,
    getPendingList,
    getConfig,
    updateConfig,
    buildReconcileUseCases().listInFlight,
    buildReconcileUseCases().reconcile,
    ((_req: unknown, _res: unknown, next: () => void) => next()) as never,
    new FakeAuthProvider(),
    undefined,
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

  // ── Task 2.2: status endpoint response includes `failed` field (REQ-STATUS-1) ──

  it('2.2: GET /closure/status includes failed field (zero before first run)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/iclass/closure/status').set(...AUTH);
    expect(res.status).toBe(200);
    // failed must be present as a numeric field
    expect(typeof res.body.counts.failed).toBe('number');
    expect(res.body.counts.failed).toBe(0);
  });

  // -----------------------------------------------------------------------
  // REQ-BACKFILL-1: POST /closure/backfill → 202 (async dispatch)
  // -----------------------------------------------------------------------

  // A3.1: dispatch exitoso → 202 {queued:true}
  it('POST /closure/backfill → 202 {queued:true} when dispatch succeeds', async () => {
    const { app } = buildApp({ queued: true }, undefined, undefined, undefined, { queued: true });
    const res = await request(app).post('/api/admin/iclass/closure/backfill').set(...AUTH);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
  });

  // A3.2: run ya en vuelo → 202 {queued:false, reason:'already-running'}
  it('POST /closure/backfill → 202 {queued:false, reason:"already-running"} when in flight', async () => {
    const { app } = buildApp({ queued: true }, undefined, undefined, undefined, { queued: false, reason: 'already-running' });
    const res = await request(app).post('/api/admin/iclass/closure/backfill').set(...AUTH);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: false, reason: 'already-running' });
  });

  // A3.3: scheduler null → 503 {reason:'unavailable'}
  it('POST /closure/backfill → 503 when backfill scheduler is null', async () => {
    const { app } = buildAppNullBackfillScheduler();
    const res = await request(app).post('/api/admin/iclass/closure/backfill').set(...AUTH);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ reason: 'unavailable' });
  });

  // A3.4: sin auth → 401
  it('POST /closure/backfill → 401 without auth', async () => {
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

  // -----------------------------------------------------------------------
  // Closure config endpoints — GET /closure/config, PUT /closure/config
  // -----------------------------------------------------------------------

  it('GET /closure/config → 200 with defaults when no record exists (spec scenario 4)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/iclass/closure/config').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ closureIntervalMs: 600000, autocompleteIntervalMs: 900000 });
  });

  it('GET /closure/config → 200 with persisted values (spec scenario 3)', async () => {
    const cfgRepo = new InMemoryIClassClosureConfigRepository();
    await cfgRepo.update({ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 });
    const { app } = buildApp({ queued: true }, undefined, undefined, cfgRepo);
    const res = await request(app).get('/api/admin/iclass/closure/config').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 });
  });

  it('PUT /closure/config → 200 full update persists both fields (spec scenario 5)', async () => {
    const { app, cfgRepo } = buildApp();
    const res = await request(app)
      .put('/api/admin/iclass/closure/config')
      .set(...AUTH)
      .send({ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 });
    // Subsequent GET returns the same values
    const getRes = await request(app).get('/api/admin/iclass/closure/config').set(...AUTH);
    expect(getRes.body).toEqual({ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 });
    // Check repo directly as well
    const stored = await cfgRepo.get();
    expect(stored).toEqual({ closureIntervalMs: 120000, autocompleteIntervalMs: 300000 });
  });

  it('PUT /closure/config → 200 partial update (closureIntervalMs only) (spec scenario 6)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/admin/iclass/closure/config')
      .set(...AUTH)
      .send({ closureIntervalMs: 120000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ closureIntervalMs: 120000, autocompleteIntervalMs: 900000 });
  });

  it('PUT /closure/config → 400 VALIDATION_ERROR when interval below floor (30000) (spec scenario 7)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/admin/iclass/closure/config')
      .set(...AUTH)
      .send({ closureIntervalMs: 30000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /closure/config → 400 VALIDATION_ERROR when non-positive (0) (spec scenario 8)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/admin/iclass/closure/config')
      .set(...AUTH)
      .send({ autocompleteIntervalMs: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /closure/config → 400 VALIDATION_ERROR when wrong type ("soon") (spec scenario 9)', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/admin/iclass/closure/config')
      .set(...AUTH)
      .send({ closureIntervalMs: 'soon' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('GET /closure/config → 401 without auth token (spec scenario 10)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/iclass/closure/config');
    expect(res.status).toBe(401);
  });

  it('PUT /closure/config → 403 when requireIClassManage rejects (spec scenario 11)', async () => {
    const rejectMiddleware = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => {
      res.status(403).json({ code: 'PERMISSION_DENIED' });
    };
    const { app } = buildApp({ queued: true }, undefined, rejectMiddleware as never);
    const res = await request(app)
      .put('/api/admin/iclass/closure/config')
      .set(...AUTH)
      .send({ closureIntervalMs: 120000 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('GET /closure/config → 200 when authorized user has iclass:manage (spec scenario 12)', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/iclass/closure/config').set(...AUTH);
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // #35 Part 2 — GET /closure/in-flight (in-flight task list)
  // -----------------------------------------------------------------------

  it('GET /closure/in-flight → 200 list with DTO fields per task', async () => {
    const reconcileUseCases = buildReconcileUseCases();
    reconcileUseCases.scheduling.seedTask({
      id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id,
      title: 'Instalación fibra', customerName: 'Juan Pérez', customerCode: 'CLI-99', iclassOrderCode: 'SO-900',
    });
    const { app } = buildApp({ queued: true }, undefined, undefined, undefined, { queued: true }, reconcileUseCases);
    const res = await request(app).get('/api/admin/iclass/closure/in-flight').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toEqual({
      id: 't1', sequenceNumber: 4013, title: 'Instalación fibra',
      customerName: 'Juan Pérez', customerCode: 'CLI-99', iclassOrderCode: 'SO-900',
    });
  });

  it('GET /closure/in-flight → 200 empty array when no tasks are in-flight', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/admin/iclass/closure/in-flight').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('GET /closure/in-flight → 401 without auth', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/api/admin/iclass/closure/in-flight')).status).toBe(401);
  });

  it('GET /closure/in-flight → 403 when requireIClassManage rejects', async () => {
    const rejectMiddleware = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => {
      res.status(403).json({ code: 'FORBIDDEN' });
    };
    const { app } = buildApp({ queued: true }, undefined, rejectMiddleware as never);
    const res = await request(app).get('/api/admin/iclass/closure/in-flight').set(...AUTH);
    expect(res.status).toBe(403);
  });

  // -----------------------------------------------------------------------
  // #35 Part 2 — POST /closure/reconcile/:taskId (per-task sync reconcile)
  // -----------------------------------------------------------------------

  it('POST /closure/reconcile/:taskId → 200 with counts when task closed', async () => {
    const reconcileUseCases = buildReconcileUseCases();
    reconcileUseCases.scheduling.seedTask({ id: 't1', sequenceNumber: 4013, stageId: REGISTRADO.id });
    // SO not closed (statusCode !== '7') → safe deterministic counts, still 200.
    reconcileUseCases.iclass.serviceOrders = [{
      iclassId: '900', iclassCodigo: '4013', clusterName: 'IPNEXT INTERNET', thirdPartyCode: null, nodeCode: null,
      soTypeId: null, soTypeDescription: null, customerCode: null, customerName: null, addressCode: null, addressLine: null,
      addressCity: null, addressLat: null, addressLng: null, statusCode: '3', statusDescription: 'En curso',
      requestedAt: null, scheduledFor: null, availableAt: null, serviceStartedAt: null, serviceEndedAt: null,
      resultCodeName: null, closedByLogin: null, closedByName: null,
      closeLatitude: null, closeLongitude: null, closeGpsAt: null, billingAmount: null,
      technicianNote: null, internalNote: null, commentaryLog: null,
      teamLogin: null, teamTechnicianName: null, teamPhone: null, teamEmail: null,
      iclassCreatedAt: null, iclassUpdatedAt: '2026-05-21T17:49:12.000Z', rawDetail: {},
    }];
    const { app } = buildApp({ queued: true }, undefined, undefined, undefined, { queued: true }, reconcileUseCases);
    const res = await request(app).post('/api/admin/iclass/closure/reconcile/t1').set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('mirrored');
    expect(res.body).toHaveProperty('transitioned');
    expect(res.body).toHaveProperty('skippedNotClosed');
    expect(res.body).toHaveProperty('failed');
    expect(res.body.skippedNotClosed).toBe(1);
  });

  it('POST /closure/reconcile/:taskId → 404 for an unknown task id', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/admin/iclass/closure/reconcile/ghost').set(...AUTH);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  it('POST /closure/reconcile/:taskId → 401 without auth', async () => {
    const { app } = buildApp();
    expect((await request(app).post('/api/admin/iclass/closure/reconcile/t1')).status).toBe(401);
  });

  it('POST /closure/reconcile/:taskId → 403 when requireIClassManage rejects', async () => {
    const rejectMiddleware = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => {
      res.status(403).json({ code: 'FORBIDDEN' });
    };
    const { app } = buildApp({ queued: true }, undefined, rejectMiddleware as never);
    const res = await request(app).post('/api/admin/iclass/closure/reconcile/t1').set(...AUTH);
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

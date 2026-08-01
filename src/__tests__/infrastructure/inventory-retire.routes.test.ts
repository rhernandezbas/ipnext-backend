/**
 * Route tests for POST /api/scheduling/:taskId/inventory/retire (#39)
 * Scenarios: SCEN-RET-9 (403 no invWrite), SCEN-RET-8 (400 empty), SCEN-RET-7 (422 no contract), SCEN-RET-1 (200 happy path)
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { errorHandler } from '../../infrastructure/http/middleware/errorHandler';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryContractInventoryRepository } from '../../infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryInventoryAssetRepository } from '../../infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryInventoryMovementRepository } from '../../infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryMaterialStockRepository } from '../../infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryStockLocationRepository } from '../../infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventorySuggestionRepository } from '../../infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryUnitOfWork } from '../../infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { RetireContractEquipment } from '../../application/use-cases/RetireContractEquipment';
import { ResolveDepotLocation } from '../../application/use-cases/ResolveDepotLocation';
import { createInventoryAsset } from '../../domain/entities/inventory-asset';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';

const TASK_ID = 'task-retire-route-1';
const CONTRACT_ID = 'contract-route-1';
const PROJECT_ID = 'proj-route-1';

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

const rejectGuard: RequestHandler = (_req, res) => {
  res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
};
const allowGuard: RequestHandler = (_req, _res, next) => next();

async function buildApp(opts?: { invWriteGuard?: RequestHandler; withRetirementProject?: boolean; withContract?: boolean }) {
  const schedulingRepo = new InMemorySchedulingRepository();
  const contractInvRepo = new InMemoryContractInventoryRepository();
  const assetRepo = new InMemoryInventoryAssetRepository();
  const materialStockRepo = new InMemoryMaterialStockRepository();
  const movementRepo = new InMemoryInventoryMovementRepository(assetRepo, materialStockRepo);
  const locationRepo = new InMemoryStockLocationRepository();
  const suggestionsRepo = new InMemoryInventorySuggestionRepository();
  const uow = new InMemoryUnitOfWork(suggestionsRepo, contractInvRepo, locationRepo, assetRepo, movementRepo, materialStockRepo);
  const resolveDepot = new ResolveDepotLocation(locationRepo);
  await resolveDepot.execute('DEPOSITO');

  const withContract = opts?.withContract ?? true;
  const withRetirementProject = opts?.withRetirementProject ?? true;

  schedulingRepo.seedTask({
    id: TASK_ID,
    projectId: withRetirementProject ? PROJECT_ID : null,
    projectAllowsRetirement: withRetirementProject,
    contractId: withContract ? CONTRACT_ID : null,
  });

  const retireUC = new RetireContractEquipment(schedulingRepo, contractInvRepo, assetRepo, movementRepo, resolveDepot, uow);

  // Minimal stubs for required createSchedulingRouter args
  const listTasks = new ListTasks(schedulingRepo);
  const getTask = new GetTask(schedulingRepo);
  const createTask = {} as CreateTask;
  const updateTask = {} as UpdateTask;
  const deleteTask = {} as DeleteTask;
  const moveTask = {} as MoveTaskToStage;
  const auth = new FakeAuthProvider();

  const invWriteGuard = opts?.invWriteGuard ?? allowGuard;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/scheduling',
    createSchedulingRouter(
      listTasks,
      getTask,
      createTask,
      updateTask,
      deleteTask,
      moveTask,
      auth,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      invWriteGuard,
      retireUC,
    ),
  );
  app.use(errorHandler);

  return { app, contractInvRepo, assetRepo, locationRepo };
}

/** Repo that throws a Prisma P2002 error on execute — simulates concurrent retire race condition. */
class P2002ThrowingRetireUC {
  async execute(_input: unknown): Promise<never> {
    const err = new Error('Unique constraint failed') as Error & { code?: string };
    err.code = 'P2002';
    throw err;
  }
}

describe('POST /api/scheduling/:taskId/inventory/retire', () => {
  it('SCEN-RET-9: without inventory.write guard → 403', async () => {
    const { app } = await buildApp({ invWriteGuard: rejectGuard });

    const res = await request(app)
      .post(`/api/scheduling/${TASK_ID}/inventory/retire`)
      .set('Cookie', 'auth_token=fake')
      .send({ itemIds: ['some-cii'] });

    expect(res.status).toBe(403);
  });

  it('SCEN-RET-8: empty itemIds → 400 VALIDATION_ERROR', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post(`/api/scheduling/${TASK_ID}/inventory/retire`)
      .set('Cookie', 'auth_token=fake')
      .send({ itemIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('SCEN-RET-7: task without contractId → 422 TASK_HAS_NO_CONTRACT', async () => {
    const { app } = await buildApp({ withContract: false });

    const res = await request(app)
      .post(`/api/scheduling/${TASK_ID}/inventory/retire`)
      .set('Cookie', 'auth_token=fake')
      .send({ itemIds: ['some-cii'] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TASK_HAS_NO_CONTRACT');
  });

  it('FIX-4: P2002 concurrent retire → 409 RETIRE_ALREADY_DONE', async () => {
    // Two concurrent requests both pass the pre-write findBySourceRef check.
    // The loser hits the DB partial-unique index and gets a P2002 — must map to 409.
    const { app: baseApp } = await buildApp();

    // Build a fresh app that wires our P2002-throwing stub instead of the real use case
    const schedulingRepo2 = new InMemorySchedulingRepository();
    schedulingRepo2.seedTask({
      id: TASK_ID,
      projectId: PROJECT_ID,
      projectAllowsRetirement: true,
      contractId: CONTRACT_ID,
    });

    const app2 = express();
    app2.use(cookieParser());
    app2.use(express.json());
    app2.use(
      '/api/scheduling',
      createSchedulingRouter(
        new ListTasks(schedulingRepo2),
        new GetTask(schedulingRepo2),
        {} as CreateTask,
        {} as UpdateTask,
        {} as DeleteTask,
        {} as MoveTaskToStage,
        new FakeAuthProvider(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        allowGuard,
        new P2002ThrowingRetireUC() as unknown as RetireContractEquipment,
      ),
    );
    app2.use(errorHandler);

    const res = await request(app2)
      .post(`/api/scheduling/${TASK_ID}/inventory/retire`)
      .set('Cookie', 'auth_token=fake')
      .send({ itemIds: ['some-cii'] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RETIRE_ALREADY_DONE');
  });

  // FIX-5 gap scenarios
  it('FIX-5: project does not allow retirement → 422 PROJECT_NOT_RETIREMENT', async () => {
    const { app } = await buildApp({ withRetirementProject: false, withContract: true });

    const res = await request(app)
      .post(`/api/scheduling/${TASK_ID}/inventory/retire`)
      .set('Cookie', 'auth_token=fake')
      .send({ itemIds: ['some-cii'] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PROJECT_NOT_RETIREMENT');
  });

  it('FIX-5: CII not on task contract → 422 EQUIPMENT_NOT_ON_CONTRACT', async () => {
    const { app } = await buildApp();
    // 'nonexistent-cii' is not seeded in contractInvRepo → EquipmentNotOnContractError

    const res = await request(app)
      .post(`/api/scheduling/${TASK_ID}/inventory/retire`)
      .set('Cookie', 'auth_token=fake')
      .send({ itemIds: ['nonexistent-cii'] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('EQUIPMENT_NOT_ON_CONTRACT');
  });

  it('FIX-5: serial re-retire (domain RetireAlreadyDoneError) → 409 RETIRE_ALREADY_DONE', async () => {
    // Use a stub that throws RetireAlreadyDoneError directly (domain-level duplicate detection)
    const { RetireAlreadyDoneError: RAD } = await import('../../domain/errors/inventory');
    const schedulingRepo3 = new InMemorySchedulingRepository();
    schedulingRepo3.seedTask({
      id: TASK_ID,
      projectId: PROJECT_ID,
      projectAllowsRetirement: true,
      contractId: CONTRACT_ID,
    });

    const stubUC = { execute: async () => { throw new RAD('cii-already-done'); } };

    const app3 = express();
    app3.use(cookieParser());
    app3.use(express.json());
    app3.use(
      '/api/scheduling',
      createSchedulingRouter(
        new ListTasks(schedulingRepo3),
        new GetTask(schedulingRepo3),
        {} as CreateTask,
        {} as UpdateTask,
        {} as DeleteTask,
        {} as MoveTaskToStage,
        new FakeAuthProvider(),
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        allowGuard,
        stubUC as unknown as RetireContractEquipment,
      ),
    );
    app3.use(errorHandler);

    const res = await request(app3)
      .post(`/api/scheduling/${TASK_ID}/inventory/retire`)
      .set('Cookie', 'auth_token=fake')
      .send({ itemIds: ['cii-already-done'] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RETIRE_ALREADY_DONE');
  });

  it('SCEN-RET-1: happy path with valid CII → 200 with retired item', async () => {
    const { app, contractInvRepo, assetRepo, locationRepo } = await buildApp();

    const depot = await locationRepo.findByCode('DEPOSITO');
    const clientLocId = 'loc-client-route';
    locationRepo.store.set(clientLocId, { id: clientLocId, type: 'CLIENTE', contractId: CONTRACT_ID, technicianId: null, vehicleId: null, code: null });

    const assetId = `asset-route-${Date.now()}`;
    assetRepo.store.set(assetId, createInventoryAsset({
      id: assetId,
      serialNumber: 'SN-ROUTE-1',
      mac: null,
      deviceTypeId: 'dt-onu',
      status: 'installed',
      currentLocationId: clientLocId,
      source: 'MANUAL',
      sourceTaskId: null,
    }));

    const ciiId = `cii-route-${Date.now()}`;
    contractInvRepo.store.set(ciiId, {
      id: ciiId,
      contractId: CONTRACT_ID,
      type: 'ONU',
      serialNumber: 'SN-ROUTE-1',
      mac: null,
      model: null,
      source: 'MANUAL',
      sourceTaskId: null,
      addedByUserId: null,
      confirmedAt: null,
      status: 'active',
      notes: null,
      replacesItemId: null,
      assetId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const res = await request(app)
      .post(`/api/scheduling/${TASK_ID}/inventory/retire`)
      .set('Cookie', 'auth_token=fake')
      .send({ itemIds: [ciiId] });

    expect(res.status).toBe(200);
    expect(res.body.retired).toHaveLength(1);
    expect(res.body.retired[0].itemId).toBe(ciiId);
    expect(res.body.retired[0].status).toBe('removed');
    expect(res.body.retired[0].assetReturned).toBe(true);
  });
});

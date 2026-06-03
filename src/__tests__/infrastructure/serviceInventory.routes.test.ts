import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

import { createContractInventoryRouter } from '@infrastructure/http/routes/contractInventory.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';
import { ListTaskInventorySuggestions } from '@application/use-cases/ListTaskInventorySuggestions';
import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { DiscardInventorySuggestion } from '@application/use-cases/DiscardInventorySuggestion';
import { ListContractInstalledItems } from '@application/use-cases/ListContractInstalledItems';
import { AddInstalledItemManually } from '@application/use-cases/AddInstalledItemManually';
import { UpdateInstalledItem } from '@application/use-cases/UpdateInstalledItem';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';

const BASE_TYPES = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];

const sug = (over: Partial<TaskInventorySuggestion>): TaskInventorySuggestion => ({
  id: 's1', taskId: 't1', kind: 'DEVICE', deviceType: 'ROUTER', qwenDeviceType: null, serialNumber: 'R1', mac: 'MR',
  materialDesc: null, quantity: null, unit: null, source: 'OCR', photoUrl: null,
  status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z', ...over,
});

async function buildApp() {
  const suggestions = new InMemoryInventorySuggestionRepository();
  const inventory = new InMemoryContractInventoryRepository();
  const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());
  const users = new InMemoryRbacUserRepository();
  const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
  for (const name of BASE_TYPES) await catalogRepo.create({ name, active: true, sortOrder: 0 });
  const deviceTypeCatalogService = new DeviceTypeCatalogService(catalogRepo);

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as { user?: { id: string } }).user = { id: 'u1' };
    next();
  };
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();

  const router = createContractInventoryRouter(
    new ListTaskInventorySuggestions(suggestions),
    new ConfirmInventorySuggestion(suggestions, inventory, scheduling, users, catalogRepo),
    new DiscardInventorySuggestion(suggestions),
    new ListContractInstalledItems(inventory, users),
    new AddInstalledItemManually(inventory),
    new UpdateInstalledItem(inventory),
    auth,
    { taskRead: pass, taskWrite: pass, contractRead: pass, contractWrite: pass },
    deviceTypeCatalogService,
  );

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use(errorHandler);
  return { app, suggestions, inventory, scheduling };
}

describe('contractInventory routes', () => {
  it('POST confirm → 201 ContractInstalledItem; suggestion confirmed', async () => {
    const { app, suggestions, scheduling } = await buildApp();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', serialNumber: 'R1' }));

    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send();
    expect(res.status).toBe(201);
    expect(res.body.contractId).toBe('svc1');
    expect(res.body.serialNumber).toBe('R1');
    expect(res.body.addedByUserId).toBe('u1');
    expect((await suggestions.get('s1'))!.status).toBe('confirmed');
  });

  it('F5: POST confirm con type override válido → 201 y guarda el tipo elegido', async () => {
    const { app, suggestions, scheduling } = await buildApp();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ONU' }));

    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send({ type: 'ROUTER' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('ROUTER');
  });

  it('D.3: POST confirm con type inválido → 422 INVALID_ITEM_TYPE', async () => {
    const { app, suggestions, scheduling } = await buildApp();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1' }));

    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send({ type: 'SUBMARINO' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_ITEM_TYPE');
  });

  it('POST confirm twice → 409 SUGGESTION_ALREADY_CONFIRMED', async () => {
    const { app, suggestions, scheduling } = await buildApp();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1' }));
    await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send();

    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUGGESTION_ALREADY_CONFIRMED');
  });

  it('POST confirm with task without contract → 409 TASK_HAS_NO_CONTRACT', async () => {
    const { app, suggestions, scheduling } = await buildApp();
    scheduling.seedTask({ id: 't1', contractId: null });
    await suggestions.upsert(sug({ id: 's1' }));

    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TASK_HAS_NO_CONTRACT');
  });

  it('POST confirm unknown suggestion → 404 SUGGESTION_NOT_FOUND', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/nope/confirm').send();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SUGGESTION_NOT_FOUND');
  });

  it('GET suggestions → list for the task', async () => {
    const { app, suggestions } = await buildApp();
    await suggestions.upsert(sug({ id: 's1' }));
    const res = await request(app).get('/api/scheduling/t1/inventory/suggestions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('POST discard → 200 discarded', async () => {
    const { app, suggestions } = await buildApp();
    await suggestions.upsert(sug({ id: 's1' }));
    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/discard').send();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('discarded');
  });

  it('POST manual add → 201; GET inventory lists it', async () => {
    const { app } = await buildApp();
    const add = await request(app).post('/api/contracts/svc1/inventory').send({ type: 'ROUTER', serialNumber: 'R2' });
    expect(add.status).toBe(201);
    expect(add.body.source).toBe('MANUAL');

    const list = await request(app).get('/api/contracts/svc1/inventory');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].serialNumber).toBe('R2');
  });

  it('D.3: POST manual add con type inválido → 422 INVALID_ITEM_TYPE', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/contracts/svc1/inventory').send({ type: 'LASER' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_ITEM_TYPE');
  });

  it('PATCH installed item → 200 updated; unknown → 404', async () => {
    const { app, inventory } = await buildApp();
    const created = await inventory.create({
      id: 'i1', contractId: 'svc1', type: 'ROUTER', serialNumber: 'R1', mac: null, model: null,
      source: 'MANUAL', sourceTaskId: null, addedByUserId: null, confirmedAt: null,
      status: 'active', notes: null, createdAt: 'x', updatedAt: 'x',
    });
    const ok = await request(app).patch('/api/contracts/svc1/inventory/i1').send({ status: 'removed' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('removed');
    expect(created.id).toBe('i1');

    const missing = await request(app).patch('/api/contracts/svc1/inventory/nope').send({ status: 'removed' });
    expect(missing.status).toBe(404);
  });
});

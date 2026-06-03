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
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { InMemoryTaskMaterialConsumptionRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskMaterialConsumptionRepository';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';
import { ListTaskInventorySuggestions } from '@application/use-cases/ListTaskInventorySuggestions';
import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { CorrectConfirmedDeviceType } from '@application/use-cases/CorrectConfirmedDeviceType';
import { DiscardInventorySuggestion } from '@application/use-cases/DiscardInventorySuggestion';
import { ListContractInstalledItems } from '@application/use-cases/ListContractInstalledItems';
import { AddInstalledItemManually } from '@application/use-cases/AddInstalledItemManually';
import { UpdateInstalledItem } from '@application/use-cases/UpdateInstalledItem';
import { RemoveInstalledItem } from '@application/use-cases/RemoveInstalledItem';
import { RecordMaterialConsumption } from '@application/use-cases/RecordMaterialConsumption';
import { ListTaskMaterialConsumptions } from '@application/use-cases/ListTaskMaterialConsumptions';
import { DeleteMaterialConsumption } from '@application/use-cases/DeleteMaterialConsumption';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { TaskMaterialConsumption } from '@domain/entities/task-material-consumption';

const BASE_TYPES = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];

const sug = (over: Partial<TaskInventorySuggestion>): TaskInventorySuggestion => ({
  id: 's1', taskId: 't1', kind: 'DEVICE', deviceType: 'ROUTER', qwenDeviceType: null, serialNumber: 'R1', mac: 'MR',
  materialDesc: null, quantity: null, unit: null, source: 'OCR', photoUrl: null,
  status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z', ...over,
});

const makeItem = (over: Partial<ContractInstalledItem> = {}): ContractInstalledItem => ({
  id: 'i1', contractId: 'svc1', type: 'ROUTER', serialNumber: 'R1', mac: null, model: null,
  source: 'MANUAL', sourceTaskId: null, addedByUserId: null, confirmedAt: null,
  status: 'active', notes: null, createdAt: 'x', updatedAt: 'x', ...over,
});

const makeConsumption = (over: Partial<TaskMaterialConsumption> = {}): TaskMaterialConsumption => ({
  id: 'c1', taskId: 't1', materialCatalogId: 'm1', materialName: 'CABLE_UTP',
  quantity: 5, unit: 'm', notes: null, recordedByUserId: null,
  createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', ...over,
});

async function buildApp() {
  const suggestions = new InMemoryInventorySuggestionRepository();
  const inventory = new InMemoryContractInventoryRepository();
  const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());
  const users = new InMemoryRbacUserRepository();
  const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
  for (const name of BASE_TYPES) await catalogRepo.create({ name, active: true, sortOrder: 0 });
  const deviceTypeCatalogService = new DeviceTypeCatalogService(catalogRepo);
  const materialRepo = new InMemoryMaterialCatalogRepository();
  await materialRepo.create({ name: 'CABLE_UTP', unit: 'm', active: true, sortOrder: 0 });
  await materialRepo.create({ name: 'OTRO', unit: 'unidad', active: true, sortOrder: 99 });
  const consumptionRepo = new InMemoryTaskMaterialConsumptionRepository();

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as { user?: { id: string } }).user = { id: 'u1' };
    next();
  };
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  const deny = (_req: Request, res: Response) => res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

  const router = createContractInventoryRouter(
    new ListTaskInventorySuggestions(suggestions, inventory, scheduling),
    new ConfirmInventorySuggestion(suggestions, inventory, scheduling, users, catalogRepo, materialRepo, consumptionRepo),
    new DiscardInventorySuggestion(suggestions),
    new CorrectConfirmedDeviceType(suggestions, inventory),
    new ListContractInstalledItems(inventory, users),
    new AddInstalledItemManually(inventory),
    new UpdateInstalledItem(inventory),
    new RemoveInstalledItem(inventory),
    new RecordMaterialConsumption(consumptionRepo, materialRepo),
    new ListTaskMaterialConsumptions(consumptionRepo, users),
    new DeleteMaterialConsumption(consumptionRepo),
    auth,
    { taskRead: pass, taskWrite: pass, contractRead: pass, contractWrite: pass, materialWrite: pass, manage: pass },
    deviceTypeCatalogService,
  );

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use(errorHandler);
  return { app, suggestions, inventory, scheduling, materialRepo, consumptionRepo };
}

// App with deny middleware to test permission guards
async function buildAppWithPerms(perms: {
  taskRead?: boolean; taskWrite?: boolean; contractRead?: boolean; contractWrite?: boolean; materialWrite?: boolean; manage?: boolean;
}) {
  const suggestions = new InMemoryInventorySuggestionRepository();
  const inventory = new InMemoryContractInventoryRepository();
  const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());
  const users = new InMemoryRbacUserRepository();
  const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
  for (const name of BASE_TYPES) await catalogRepo.create({ name, active: true, sortOrder: 0 });
  const deviceTypeCatalogService = new DeviceTypeCatalogService(catalogRepo);
  const materialRepo = new InMemoryMaterialCatalogRepository();
  await materialRepo.create({ name: 'OTRO', unit: 'unidad', active: true, sortOrder: 99 });
  const consumptionRepo = new InMemoryTaskMaterialConsumptionRepository();

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as { user?: { id: string } }).user = { id: 'u1' };
    next();
  };
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  const deny = (_req: Request, res: Response) => res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

  const router = createContractInventoryRouter(
    new ListTaskInventorySuggestions(suggestions, inventory, scheduling),
    new ConfirmInventorySuggestion(suggestions, inventory, scheduling, users, catalogRepo, materialRepo, consumptionRepo),
    new DiscardInventorySuggestion(suggestions),
    new CorrectConfirmedDeviceType(suggestions, inventory),
    new ListContractInstalledItems(inventory, users),
    new AddInstalledItemManually(inventory),
    new UpdateInstalledItem(inventory),
    new RemoveInstalledItem(inventory),
    new RecordMaterialConsumption(consumptionRepo, materialRepo),
    new ListTaskMaterialConsumptions(consumptionRepo, users),
    new DeleteMaterialConsumption(consumptionRepo),
    auth,
    {
      taskRead:      perms.taskRead      ? pass : deny,
      taskWrite:     perms.taskWrite     ? pass : deny,
      contractRead:  perms.contractRead  ? pass : deny,
      contractWrite: perms.contractWrite ? pass : deny,
      materialWrite: perms.materialWrite ? pass : deny,
      manage:        perms.manage        ? pass : deny,
    },
    deviceTypeCatalogService,
  );

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use(errorHandler);
  return { app, suggestions, inventory, scheduling, materialRepo, consumptionRepo };
}

describe('contractInventory routes', () => {
  it('POST confirm DEVICE → 201 + {kind:"DEVICE", item}; suggestion confirmed', async () => {
    const { app, suggestions, scheduling } = await buildApp();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', serialNumber: 'R1' }));

    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send();
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('DEVICE');
    expect(res.body.item.contractId).toBe('svc1');
    expect(res.body.item.serialNumber).toBe('R1');
    expect(res.body.item.addedByUserId).toBe('u1');
    expect((await suggestions.get('s1'))!.status).toBe('confirmed');
  });

  it('POST confirm MATERIAL → 201 + {kind:"MATERIAL", consumption}', async () => {
    const { app, suggestions, scheduling } = await buildApp();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', deviceType: null, serialNumber: null,
      materialDesc: 'cable_utp', quantity: 5, unit: 'm',
    }));

    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send();
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('MATERIAL');
    expect(res.body.consumption).toBeDefined();
    expect(res.body.consumption.quantity).toBe(5);
    expect(res.body.item).toBeUndefined();
  });

  it('F5: POST confirm con type override válido → 201 y guarda el tipo elegido', async () => {
    const { app, suggestions, scheduling } = await buildApp();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ONU' }));

    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send({ type: 'ROUTER' });
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe('DEVICE');
    expect(res.body.item.type).toBe('ROUTER');
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
    const created = await inventory.create(makeItem());
    const ok = await request(app).patch('/api/contracts/svc1/inventory/i1').send({ status: 'removed' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('removed');
    expect(created.id).toBe('i1');

    const missing = await request(app).patch('/api/contracts/svc1/inventory/nope').send({ status: 'removed' });
    expect(missing.status).toBe(404);
  });

  it('PATCH installed item with valid type → 200', async () => {
    const { app, inventory } = await buildApp();
    await inventory.create(makeItem());
    const res = await request(app).patch('/api/contracts/svc1/inventory/i1').send({ type: 'ONU' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('ONU');
  });

  it('PATCH installed item with invalid type → 422 INVALID_ITEM_TYPE', async () => {
    const { app, inventory } = await buildApp();
    await inventory.create(makeItem());
    const res = await request(app).patch('/api/contracts/svc1/inventory/i1').send({ type: 'SUBMARINO' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_ITEM_TYPE');
  });
});

describe('DELETE /contracts/:contractId/inventory/:itemId', () => {
  it('soft-removes an active item → 200 + item with status=removed', async () => {
    const { app, inventory } = await buildApp();
    await inventory.create(makeItem({ id: 'i1', status: 'active' }));
    const res = await request(app).delete('/api/contracts/svc1/inventory/i1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('removed');
    expect(res.body.id).toBe('i1');
  });

  it('returns 404 when item does not exist', async () => {
    const { app } = await buildApp();
    const res = await request(app).delete('/api/contracts/svc1/inventory/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INSTALLED_ITEM_NOT_FOUND');
  });

  it('is idempotent: removing an already-removed item returns 200 + the item (no error)', async () => {
    const { app, inventory } = await buildApp();
    await inventory.create(makeItem({ id: 'i1', status: 'removed' }));
    const res = await request(app).delete('/api/contracts/svc1/inventory/i1');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('removed');
  });

  it('requires contractWrite guard (403 without it)', async () => {
    const { app, inventory } = await buildAppWithPerms({ contractWrite: false });
    await inventory.create(makeItem({ id: 'i1', status: 'active' }));
    const res = await request(app).delete('/api/contracts/svc1/inventory/i1');
    expect(res.status).toBe(403);
  });
});

describe('Material consumption routes', () => {
  it('GET /scheduling/:taskId/inventory/materials → list consumptions', async () => {
    const { app, consumptionRepo } = await buildApp();
    await consumptionRepo.create(makeConsumption({ id: 'c1', taskId: 't1' }));
    const res = await request(app).get('/api/scheduling/t1/inventory/materials');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('c1');
  });

  it('POST /scheduling/:taskId/inventory/materials → 201 created', async () => {
    const { app, materialRepo } = await buildApp();
    const mat = await materialRepo.getByName('CABLE_UTP');
    const res = await request(app).post('/api/scheduling/t1/inventory/materials').send({
      materialCatalogId: mat!.id,
      quantity: 3,
      unit: 'm',
    });
    expect(res.status).toBe(201);
    expect(res.body.quantity).toBe(3);
    expect(res.body.materialName).toBe('CABLE_UTP');
  });

  it('POST /scheduling/:taskId/inventory/materials with missing materialCatalogId → 400', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/scheduling/t1/inventory/materials').send({ quantity: 3 });
    expect(res.status).toBe(400);
  });

  it('POST /scheduling/:taskId/inventory/materials with quantity 0 → 400 (Zod rejects non-positive)', async () => {
    const { app, materialRepo } = await buildApp();
    const mat = await materialRepo.getByName('CABLE_UTP');
    const res = await request(app).post('/api/scheduling/t1/inventory/materials').send({
      materialCatalogId: mat!.id,
      quantity: 0,
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /scheduling/:taskId/inventory/materials/:id → 204', async () => {
    const { app, consumptionRepo } = await buildApp();
    await consumptionRepo.create(makeConsumption({ id: 'c1', taskId: 't1' }));
    const res = await request(app).delete('/api/scheduling/t1/inventory/materials/c1');
    expect(res.status).toBe(204);
  });

  it('DELETE /scheduling/:taskId/inventory/materials/:id nonexistent → 404', async () => {
    const { app } = await buildApp();
    const res = await request(app).delete('/api/scheduling/t1/inventory/materials/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MATERIAL_CONSUMPTION_NOT_FOUND');
  });

  it('POST consumption requires materialWrite guard (403 without it)', async () => {
    const { app, materialRepo } = await buildAppWithPerms({ materialWrite: false });
    const mat = await materialRepo.getByName('OTRO');
    const res = await request(app).post('/api/scheduling/t1/inventory/materials').send({
      materialCatalogId: mat!.id, quantity: 1,
    });
    expect(res.status).toBe(403);
  });
});

describe('Permission guard migration (clients.* → inventory.*)', () => {
  it('GET contract inventory requires contractRead guard', async () => {
    const { app } = await buildAppWithPerms({ contractRead: false });
    const res = await request(app).get('/api/contracts/svc1/inventory');
    expect(res.status).toBe(403);
  });

  it('POST contract inventory requires contractWrite guard', async () => {
    const { app } = await buildAppWithPerms({ contractWrite: false });
    const res = await request(app).post('/api/contracts/svc1/inventory').send({ type: 'ROUTER' });
    expect(res.status).toBe(403);
  });

  it('PATCH contract inventory requires contractWrite guard', async () => {
    const { app } = await buildAppWithPerms({ contractWrite: false });
    const res = await request(app).patch('/api/contracts/svc1/inventory/i1').send({ status: 'removed' });
    expect(res.status).toBe(403);
  });

  it('GET suggestions still requires taskRead (scheduling module)', async () => {
    const { app } = await buildAppWithPerms({ taskRead: false });
    const res = await request(app).get('/api/scheduling/t1/inventory/suggestions');
    expect(res.status).toBe(403);
  });

  it('POST confirm still requires taskWrite (scheduling module)', async () => {
    const { app } = await buildAppWithPerms({ taskWrite: false });
    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send();
    expect(res.status).toBe(403);
  });
});

describe('PATCH .../type — CorrectConfirmedDeviceType route', () => {
  it('PATCH with valid UPPERCASE type → 200 + InstalledItemDto (both repos updated)', async () => {
    const { app, suggestions, inventory, scheduling } = await buildApp();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeItem({ id: 'i1', type: 'ONU' }));
    await suggestions.upsert(sug({ id: 's1', kind: 'DEVICE', status: 'confirmed', confirmedItemId: 'i1', deviceType: 'ONU' }));

    const res = await request(app)
      .patch('/api/scheduling/t1/inventory/suggestions/s1/type')
      .send({ type: 'ANTENA' });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('ANTENA');
    expect(res.body.addedByUserName).toBeNull();
    // Both repos must be updated
    const storedItem = await inventory.getById('i1');
    expect(storedItem!.type).toBe('ANTENA');
    const storedSuggestion = await suggestions.get('s1');
    expect(storedSuggestion!.deviceType).toBe('ANTENA');
  });

  it('PATCH with valid lowercase type → 200 + persists ANTENA (route normalises)', async () => {
    const { app, suggestions, inventory, scheduling } = await buildApp();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeItem({ id: 'i1', type: 'ONU' }));
    await suggestions.upsert(sug({ id: 's1', kind: 'DEVICE', status: 'confirmed', confirmedItemId: 'i1', deviceType: 'ONU' }));

    const res = await request(app)
      .patch('/api/scheduling/t1/inventory/suggestions/s1/type')
      .send({ type: 'antena' });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe('ANTENA');
  });

  it('PATCH with invalid type (SUBMARINO) → 422 INVALID_ITEM_TYPE', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .patch('/api/scheduling/t1/inventory/suggestions/s1/type')
      .send({ type: 'SUBMARINO' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_ITEM_TYPE');
  });

  it('PATCH suggestion is pending → 409 SUGGESTION_NOT_CONFIRMED', async () => {
    const { app, suggestions } = await buildApp();
    await suggestions.upsert(sug({ id: 's1', kind: 'DEVICE', status: 'pending', confirmedItemId: null }));

    const res = await request(app)
      .patch('/api/scheduling/t1/inventory/suggestions/s1/type')
      .send({ type: 'ANTENA' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUGGESTION_NOT_CONFIRMED');
  });

  it('PATCH suggestion is MATERIAL confirmed → 409 SUGGESTION_NOT_A_DEVICE', async () => {
    const { app, suggestions, inventory } = await buildApp();
    await inventory.create(makeItem({ id: 'i1' }));
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', status: 'confirmed', confirmedItemId: 'i1', deviceType: null,
    }));

    const res = await request(app)
      .patch('/api/scheduling/t1/inventory/suggestions/s1/type')
      .send({ type: 'ANTENA' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUGGESTION_NOT_A_DEVICE');
  });

  it('PATCH confirmedItemId null → 409 SUGGESTION_NOT_LINKED', async () => {
    const { app, suggestions } = await buildApp();
    await suggestions.upsert(sug({ id: 's1', kind: 'DEVICE', status: 'confirmed', confirmedItemId: null }));

    const res = await request(app)
      .patch('/api/scheduling/t1/inventory/suggestions/s1/type')
      .send({ type: 'ANTENA' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUGGESTION_NOT_LINKED');
  });

  it('PATCH no inventory.manage permission → 403', async () => {
    const { app } = await buildAppWithPerms({ manage: false });
    const res = await request(app)
      .patch('/api/scheduling/t1/inventory/suggestions/s1/type')
      .send({ type: 'ANTENA' });
    expect(res.status).toBe(403);
  });

  it('GET suggestions → response includes match field on each item (same_device case)', async () => {
    const { app, suggestions, inventory, scheduling } = await buildApp();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    // Contract has a ROUTER with SN=R1
    await inventory.create(makeItem({ id: 'i1', type: 'ROUTER', serialNumber: 'R1' }));
    // Suggestion for task t1 with same SN
    await suggestions.upsert(sug({ id: 's1', kind: 'DEVICE', deviceType: 'ROUTER', serialNumber: 'R1' }));

    const res = await request(app).get('/api/scheduling/t1/inventory/suggestions');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveProperty('match');
    expect(res.body[0].match).not.toBeNull();
    expect(res.body[0].match.status).toBe('same_device');
  });
});

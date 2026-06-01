import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

import { createServiceInventoryRouter } from '@infrastructure/http/routes/serviceInventory.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryServiceInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceInventoryRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { ListTaskInventorySuggestions } from '@application/use-cases/ListTaskInventorySuggestions';
import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { DiscardInventorySuggestion } from '@application/use-cases/DiscardInventorySuggestion';
import { ListServiceInstalledItems } from '@application/use-cases/ListServiceInstalledItems';
import { AddInstalledItemManually } from '@application/use-cases/AddInstalledItemManually';
import { UpdateInstalledItem } from '@application/use-cases/UpdateInstalledItem';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';

const sug = (over: Partial<TaskInventorySuggestion>): TaskInventorySuggestion => ({
  id: 's1', taskId: 't1', kind: 'DEVICE', deviceType: 'ROUTER', serialNumber: 'R1', mac: 'MR',
  materialDesc: null, quantity: null, unit: null, source: 'OCR', photoUrl: null,
  status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z', ...over,
});

function buildApp() {
  const suggestions = new InMemoryInventorySuggestionRepository();
  const inventory = new InMemoryServiceInventoryRepository();
  const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as { user?: { id: string } }).user = { id: 'u1' };
    next();
  };

  const router = createServiceInventoryRouter(
    new ListTaskInventorySuggestions(suggestions),
    new ConfirmInventorySuggestion(suggestions, inventory, scheduling),
    new DiscardInventorySuggestion(suggestions),
    new ListServiceInstalledItems(inventory),
    new AddInstalledItemManually(inventory),
    new UpdateInstalledItem(inventory),
    auth,
  );

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use(errorHandler);
  return { app, suggestions, inventory, scheduling };
}

describe('serviceInventory routes', () => {
  it('POST confirm → 201 ServiceInstalledItem; suggestion confirmed', async () => {
    const { app, suggestions, scheduling } = buildApp();
    scheduling.seedTask({ id: 't1', serviceId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', serialNumber: 'R1' }));

    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send();
    expect(res.status).toBe(201);
    expect(res.body.serviceId).toBe('svc1');
    expect(res.body.serialNumber).toBe('R1');
    expect(res.body.addedByUserId).toBe('u1');
    expect((await suggestions.get('s1'))!.status).toBe('confirmed');
  });

  it('POST confirm twice → 409 SUGGESTION_ALREADY_CONFIRMED', async () => {
    const { app, suggestions, scheduling } = buildApp();
    scheduling.seedTask({ id: 't1', serviceId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1' }));
    await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send();

    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUGGESTION_ALREADY_CONFIRMED');
  });

  it('POST confirm with task without service → 409 TASK_HAS_NO_SERVICE', async () => {
    const { app, suggestions, scheduling } = buildApp();
    scheduling.seedTask({ id: 't1', serviceId: null });
    await suggestions.upsert(sug({ id: 's1' }));

    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/confirm').send();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TASK_HAS_NO_SERVICE');
  });

  it('POST confirm unknown suggestion → 404 SUGGESTION_NOT_FOUND', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/nope/confirm').send();
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SUGGESTION_NOT_FOUND');
  });

  it('GET suggestions → list for the task', async () => {
    const { app, suggestions } = buildApp();
    await suggestions.upsert(sug({ id: 's1' }));
    const res = await request(app).get('/api/scheduling/t1/inventory/suggestions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('POST discard → 200 discarded', async () => {
    const { app, suggestions } = buildApp();
    await suggestions.upsert(sug({ id: 's1' }));
    const res = await request(app).post('/api/scheduling/t1/inventory/suggestions/s1/discard').send();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('discarded');
  });

  it('POST manual add → 201; GET inventory lists it', async () => {
    const { app } = buildApp();
    const add = await request(app).post('/api/services/svc1/inventory').send({ type: 'ROUTER', serialNumber: 'R2' });
    expect(add.status).toBe(201);
    expect(add.body.source).toBe('MANUAL');

    const list = await request(app).get('/api/services/svc1/inventory');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].serialNumber).toBe('R2');
  });

  it('POST manual add with bad type → 422', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/services/svc1/inventory').send({ type: 'LASER' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_ITEM_TYPE');
  });

  it('PATCH installed item → 200 updated; unknown → 404', async () => {
    const { app, inventory } = buildApp();
    const created = await inventory.create({
      id: 'i1', serviceId: 'svc1', type: 'ROUTER', serialNumber: 'R1', mac: null, model: null,
      source: 'MANUAL', sourceTaskId: null, addedByUserId: null, confirmedAt: null,
      status: 'active', notes: null, createdAt: 'x', updatedAt: 'x',
    });
    const ok = await request(app).patch('/api/services/svc1/inventory/i1').send({ status: 'removed' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('removed');
    expect(created.id).toBe('i1');

    const missing = await request(app).patch('/api/services/svc1/inventory/nope').send({ status: 'removed' });
    expect(missing.status).toBe(404);
  });
});

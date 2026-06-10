import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

import { createInventoryRouter } from '@infrastructure/http/routes/inventory.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { InMemoryReturnSuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryReturnSuggestionRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { GetTechnicianStock } from '@application/use-cases/GetTechnicianStock';
import { IssueStockToTechnician } from '@application/use-cases/IssueStockToTechnician';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { ListPendingReturns } from '@application/use-cases/ListPendingReturns';
import { ConfirmAssetReturn } from '@application/use-cases/ConfirmAssetReturn';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { ListReturnSuggestionsByTask } from '@application/use-cases/ListReturnSuggestionsByTask';
import { createReturnSuggestion } from '@domain/entities/return-suggestion';

async function buildApp(opts: { canRead: boolean }) {
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const stock = new InMemoryMaterialStockRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  const materials = new InMemoryMaterialCatalogRepository();
  const returns = new InMemoryReturnSuggestionRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, stock);

  await deviceTypes.create({ name: 'OTROS', active: true, sortOrder: 9 });

  const suggestions = new InMemoryInventorySuggestionRepository();
  const contractInv = new InMemoryContractInventoryRepository();
  const uow = new InMemoryUnitOfWork(suggestions, contractInv, locations, assets, movements, stock, returns);
  const confirm = new ConfirmAssetReturn(
    returns, assets, movements, locations, deviceTypes, new ResolveDepotLocation(locations), uow,
  );

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as { user?: { id: string } }).user = { id: 'u1' };
    next();
  };
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  const deny = (_req: Request, res: Response) => res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

  const listReturnsByTask = new ListReturnSuggestionsByTask(returns);

  const router = createInventoryRouter(
    new GetDepotStock(locations, assets, stock, deviceTypes, materials),
    new ListPendingReturns(returns),
    confirm,
    new GetTechnicianStock(locations, assets, stock, deviceTypes, materials),
    new IssueStockToTechnician(
      new ResolveDepotLocation(locations),
      new ResolveTechnicianLocation(locations),
      assets,
      uow,
    ),
    auth,
    opts.canRead ? pass : deny,
    pass,
    // optional args (W6, W5b, Wave7, depot-entry, FIX B)
    undefined, undefined, undefined, undefined,
    undefined, undefined, undefined,
    undefined, undefined,
    undefined,
    // FIX C: listReturnsByTask
    listReturnsByTask,
  );

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', router);
  app.use(errorHandler);
  return { app, returns };
}

describe('FIX C: GET /api/inventory/returns/by-task/:taskId', () => {
  it('200 with suggestions for the task (any status)', async () => {
    const { app, returns } = await buildApp({ canRead: true });

    await returns.create(createReturnSuggestion({
      id: 'rs1', taskId: 'task-1', serviceOrderId: 'so-1',
      serialNumber: 'SN-AAA', status: 'pending',
    }));
    await returns.create(createReturnSuggestion({
      id: 'rs2', taskId: 'task-1', serviceOrderId: 'so-2',
      serialNumber: 'SN-BBB', status: 'confirmed',
    }));
    // Suggestion for a different task — must NOT appear.
    await returns.create(createReturnSuggestion({
      id: 'rs3', taskId: 'task-OTHER', serviceOrderId: 'so-3',
      serialNumber: 'SN-CCC',
    }));

    const res = await request(app).get('/api/inventory/returns/by-task/task-1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    const ids = res.body.map((s: { id: string }) => s.id).sort();
    expect(ids).toEqual(['rs1', 'rs2']);

    // Verify wire contract fields.
    const rs1 = res.body.find((s: { id: string }) => s.id === 'rs1');
    expect(rs1).toMatchObject({
      id: 'rs1',
      status: 'pending',
      resolution: null,
      serialNumber: 'SN-AAA',
    });
    expect(typeof rs1.createdAt).toBe('string');

    const rs2 = res.body.find((s: { id: string }) => s.id === 'rs2');
    expect(rs2.status).toBe('confirmed');
  });

  it('200 empty array when no suggestions exist for the task', async () => {
    const { app } = await buildApp({ canRead: true });
    const res = await request(app).get('/api/inventory/returns/by-task/task-NONE');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('403 when caller lacks inventory.read permission', async () => {
    const { app } = await buildApp({ canRead: false });
    const res = await request(app).get('/api/inventory/returns/by-task/task-1');
    expect(res.status).toBe(403);
  });
});

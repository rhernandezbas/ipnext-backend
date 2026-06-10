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
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { GetTechnicianStock } from '@application/use-cases/GetTechnicianStock';
import { IssueStockToTechnician } from '@application/use-cases/IssueStockToTechnician';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { ListPendingReturns } from '@application/use-cases/ListPendingReturns';
import { ConfirmAssetReturn } from '@application/use-cases/ConfirmAssetReturn';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { ListTechniciansWithStock } from '@application/use-cases/ListTechniciansWithStock';
import { createStockLocation } from '@domain/entities/stock-location';

async function buildApp(opts: { canRead: boolean }) {
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const stock = new InMemoryMaterialStockRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  const materials = new InMemoryMaterialCatalogRepository();
  const returns = new InMemoryReturnSuggestionRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, stock);
  const users = new InMemoryRbacUserRepository();

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

  const issueStock = new IssueStockToTechnician(
    new ResolveDepotLocation(locations),
    new ResolveTechnicianLocation(locations),
    assets,
    uow,
  );

  const listTechnicians = new ListTechniciansWithStock(users, locations);

  const router = createInventoryRouter(
    new GetDepotStock(locations, assets, stock, deviceTypes, materials),
    new ListPendingReturns(returns),
    confirm,
    new GetTechnicianStock(locations, assets, stock, deviceTypes, materials),
    issueStock,
    auth,
    opts.canRead ? pass : deny,
    pass,
    // optional args (W6, W5b, Wave7, depot-entry)
    undefined, undefined, undefined, undefined,
    undefined, undefined, undefined,
    undefined, undefined,
    // FIX B: listTechnicians
    listTechnicians,
  );

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', router);
  app.use(errorHandler);
  return { app, users, locations, stock };
}

describe('N1: system "Api" user (login=api) is excluded from technician list', () => {
  it('active user with login "api" does NOT appear in the technician list', async () => {
    const { app, users } = await buildApp({ canRead: true });

    // Seed a normal technician and the system Api user.
    await users.create({ name: 'Técnico', email: 'tec@x.com', login: 'tec', passwordHash: 'x' });
    await users.create({ name: 'Api', email: 'api@sistema.local', login: 'api', passwordHash: 'x' });

    const res = await request(app).get('/api/inventory/technicians');
    expect(res.status).toBe(200);
    // Only the real technician — "Api" must be excluded.
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Técnico');
  });
});

describe('FIX B: GET /api/inventory/technicians', () => {
  it('200 happy — returns all active users with their TECNICO stock (assetCount + materialQty)', async () => {
    const { app, users, locations } = await buildApp({ canRead: true });

    // Seed two users.
    const alice = await users.create({ name: 'Alice', email: 'alice@x.com', login: 'alice', passwordHash: 'x' });
    const bob   = await users.create({ name: 'Bob',   email: 'bob@x.com',   login: 'bob',   passwordHash: 'x' });

    // Alice has a TECNICO location with content (seeded via contentOverrides).
    const aliceLoc = await locations.create(
      createStockLocation({ id: 'loc-alice', type: 'TECNICO', technicianId: alice.id }),
    );
    locations.seedContent(aliceLoc.id, { assetCount: 3, materialQty: 10, label: 'Alice' });

    // Bob has no TECNICO location — should show 0s.

    const res = await request(app).get('/api/inventory/technicians');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    // Ordered by name ASC: Alice before Bob.
    expect(res.body[0].id).toBe(alice.id);
    expect(res.body[0].name).toBe('Alice');
    expect(res.body[0].assetCount).toBe(3);
    expect(res.body[0].materialQty).toBe(10);

    expect(res.body[1].id).toBe(bob.id);
    expect(res.body[1].name).toBe('Bob');
    expect(res.body[1].assetCount).toBe(0);
    expect(res.body[1].materialQty).toBe(0);
  });

  it('200 empty list when no users exist', async () => {
    const { app } = await buildApp({ canRead: true });
    const res = await request(app).get('/api/inventory/technicians');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('403 when caller lacks inventory.read permission', async () => {
    const { app } = await buildApp({ canRead: false });
    const res = await request(app).get('/api/inventory/technicians');
    expect(res.status).toBe(403);
  });
});

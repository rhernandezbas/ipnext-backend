import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { createInventoryRouter } from '@infrastructure/http/routes/inventory.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryReturnSuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryReturnSuggestionRepository';
import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { GetTechnicianStock } from '@application/use-cases/GetTechnicianStock';
import { IssueStockToTechnician } from '@application/use-cases/IssueStockToTechnician';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { ListPendingReturns } from '@application/use-cases/ListPendingReturns';
import { ConfirmAssetReturn } from '@application/use-cases/ConfirmAssetReturn';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { AddAssetToDepot } from '@application/use-cases/AddAssetToDepot';
import { AddMaterialToDepot } from '@application/use-cases/AddMaterialToDepot';

async function buildApp(opts: { canWrite?: boolean } = {}) {
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const stock = new InMemoryMaterialStockRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  const materials = new InMemoryMaterialCatalogRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, stock);
  const returns = new InMemoryReturnSuggestionRepository();
  const suggestions = new InMemoryInventorySuggestionRepository();
  const contractInv = new InMemoryContractInventoryRepository();
  const uow = new InMemoryUnitOfWork(suggestions, contractInv, locations, assets, movements, stock, returns);

  const onu = await deviceTypes.create({ name: 'ONU', label: 'Optical Unit', active: true, sortOrder: 0 });
  const cable = await materials.create({ name: 'CABLE_UTP', label: 'Cable UTP', unit: 'm', active: true, sortOrder: 0 });
  const resolveDepot = new ResolveDepotLocation(locations);

  const auth = (_req: Request, _res: Response, next: NextFunction) => next();
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  const deny = (_req: Request, res: Response) => res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

  const canWrite = opts.canWrite ?? true;

  const router = createInventoryRouter(
    new GetDepotStock(locations, assets, stock, deviceTypes, materials),
    new ListPendingReturns(returns),
    new ConfirmAssetReturn(returns, assets, movements, locations, deviceTypes, resolveDepot, uow),
    new GetTechnicianStock(locations, assets, stock, deviceTypes, materials),
    new IssueStockToTechnician(resolveDepot, new ResolveTechnicianLocation(locations), assets, uow),
    auth,
    pass, // requireRead
    canWrite ? pass : deny, // requireWrite
    undefined, // listPendingDeductions
    undefined, // confirmMaterialDeduction
    undefined, // getVehicleStock
    undefined, // issueStockToVehicle
    undefined, // getInventoryOverview
    undefined, // listInventoryMovements
    undefined, // getLowStockAlerts
    new AddAssetToDepot(assets, movements, deviceTypes, resolveDepot, uow),
    new AddMaterialToDepot(movements, materials, stock, resolveDepot),
  );

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', router);
  app.use(errorHandler);

  return { app, onu, cable, assets, stock, locations };
}

describe('POST /api/inventory/depot/assets', () => {
  it('201 happy path — returns asset DTO', async () => {
    const { app, onu } = await buildApp();

    const res = await request(app)
      .post('/api/inventory/depot/assets')
      .send({ deviceTypeId: onu.id, serialNumber: 'SN-ROUTE-001', mac: null });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.deviceTypeId).toBe(onu.id);
    expect(res.body.deviceTypeName).toBe('ONU');
    expect(res.body.serialNumber).toBe('SN-ROUTE-001');
    expect(res.body.status).toBe('available');
  });

  it('201 with mac only', async () => {
    const { app, onu } = await buildApp();

    const res = await request(app)
      .post('/api/inventory/depot/assets')
      .send({ deviceTypeId: onu.id, mac: 'AA:BB:CC:DD:EE:FF' });

    expect(res.status).toBe(201);
    expect(res.body.mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('403 without inventory.write permission', async () => {
    const { app, onu } = await buildApp({ canWrite: false });

    const res = await request(app)
      .post('/api/inventory/depot/assets')
      .send({ deviceTypeId: onu.id, serialNumber: 'SN-AUTH' });

    expect(res.status).toBe(403);
  });

  it('400 when neither serial nor mac provided', async () => {
    const { app, onu } = await buildApp();

    const res = await request(app)
      .post('/api/inventory/depot/assets')
      .send({ deviceTypeId: onu.id });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 on missing deviceTypeId', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/api/inventory/depot/assets')
      .send({ serialNumber: 'SN-NODT' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('404 DEVICE_TYPE_NOT_FOUND for unknown deviceTypeId', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/api/inventory/depot/assets')
      .send({ deviceTypeId: 'nonexistent', serialNumber: 'SN-NOTFOUND' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DEVICE_TYPE_NOT_FOUND');
  });

  it('409 ASSET_ALREADY_EXISTS on duplicate serialNumber', async () => {
    const { app, onu } = await buildApp();

    await request(app)
      .post('/api/inventory/depot/assets')
      .send({ deviceTypeId: onu.id, serialNumber: 'SN-DUP-ROUTE' });

    const res = await request(app)
      .post('/api/inventory/depot/assets')
      .send({ deviceTypeId: onu.id, serialNumber: 'SN-DUP-ROUTE' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSET_ALREADY_EXISTS');
  });

  it('409 ASSET_ALREADY_EXISTS on duplicate mac', async () => {
    const { app, onu } = await buildApp();

    await request(app)
      .post('/api/inventory/depot/assets')
      .send({ deviceTypeId: onu.id, serialNumber: 'SN-MAC-1', mac: 'DD:EE:FF:00:11:22' });

    const res = await request(app)
      .post('/api/inventory/depot/assets')
      .send({ deviceTypeId: onu.id, serialNumber: 'SN-MAC-2', mac: 'DD:EE:FF:00:11:22' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSET_ALREADY_EXISTS');
  });
});

  it('FIX2b — 409 ASSET_ALREADY_EXISTS when asset create throws P2002 (DB backstop)', async () => {
    // Simulate a concurrent creation that wins the race: the repo throws a Prisma P2002.
    const { app, onu, assets } = await buildApp();
    const original = assets.create.bind(assets);
    assets.create = async (_asset) => {
      const err = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      throw err;
    };
    // Restore after 1 call (just for cleanliness — the app is fresh anyway).

    const res = await request(app)
      .post('/api/inventory/depot/assets')
      .send({ deviceTypeId: onu.id, serialNumber: 'SN-RACE-001' });

    assets.create = original; // restore
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSET_ALREADY_EXISTS');
  });

describe('POST /api/inventory/depot/materials', () => {
  it('200 happy path — returns ok:true + newQty', async () => {
    const { app, cable } = await buildApp();

    const res = await request(app)
      .post('/api/inventory/depot/materials')
      .send({ materialCatalogId: cable.id, qty: 100 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.materialCatalogId).toBe(cable.id);
    expect(res.body.newQty).toBe(100);
  });

  it('200 second load — newQty is cumulative', async () => {
    const { app, cable } = await buildApp();

    await request(app)
      .post('/api/inventory/depot/materials')
      .send({ materialCatalogId: cable.id, qty: 100 });

    const res = await request(app)
      .post('/api/inventory/depot/materials')
      .send({ materialCatalogId: cable.id, qty: 50 });

    expect(res.status).toBe(200);
    expect(res.body.newQty).toBe(150);
  });

  it('403 without inventory.write permission', async () => {
    const { app, cable } = await buildApp({ canWrite: false });

    const res = await request(app)
      .post('/api/inventory/depot/materials')
      .send({ materialCatalogId: cable.id, qty: 10 });

    expect(res.status).toBe(403);
  });

  it('400 qty <= 0', async () => {
    const { app, cable } = await buildApp();

    const res = await request(app)
      .post('/api/inventory/depot/materials')
      .send({ materialCatalogId: cable.id, qty: 0 });

    expect(res.status).toBe(400);
  });

  it('400 missing materialCatalogId', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/api/inventory/depot/materials')
      .send({ qty: 10 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('404 MATERIAL_NOT_FOUND for unknown materialCatalogId', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/api/inventory/depot/materials')
      .send({ materialCatalogId: 'nonexistent', qty: 10 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MATERIAL_NOT_FOUND');
  });
});

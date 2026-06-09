import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

import { createInventoryRouter } from '@infrastructure/http/routes/inventory.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { ListPendingReturns } from '@application/use-cases/ListPendingReturns';
import { ConfirmAssetReturn } from '@application/use-cases/ConfirmAssetReturn';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { InMemoryReturnSuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryReturnSuggestionRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { createStockLocation } from '@domain/entities/stock-location';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import { createMaterialStock } from '@domain/entities/material-stock';
import { createReturnSuggestion } from '@domain/entities/return-suggestion';

async function buildApp(opts: { canRead: boolean; seed?: boolean; canWrite?: boolean }) {
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const stock = new InMemoryMaterialStockRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  const materials = new InMemoryMaterialCatalogRepository();
  const returns = new InMemoryReturnSuggestionRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, stock);

  await deviceTypes.create({ name: 'OTROS', active: true, sortOrder: 9 });

  if (opts.seed) {
    await locations.create(createStockLocation({ id: 'depot-1', type: 'DEPOSITO', code: 'DEPOSITO' }));
    const onu = await deviceTypes.create({ name: 'ONU', label: 'Optical Unit', active: true, sortOrder: 0 });
    const cable = await materials.create({ name: 'CABLE_UTP', label: 'Cable UTP', unit: 'm', active: true, sortOrder: 0 });
    await assets.create(
      createInventoryAsset({
        id: 'a1', serialNumber: 'SN-A1', mac: 'MAC1', deviceTypeId: onu.id,
        status: 'available', currentLocationId: 'depot-1', source: 'MANUAL', sourceTaskId: 't9',
      }),
    );
    await stock.upsert(createMaterialStock({ id: 'ms1', materialCatalogId: cable.id, locationId: 'depot-1', qty: 42 }));
  }

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

  const router = createInventoryRouter(
    new GetDepotStock(locations, assets, stock, deviceTypes, materials),
    new ListPendingReturns(returns),
    confirm,
    auth,
    opts.canRead ? pass : deny,
    (opts.canWrite ?? true) ? pass : deny,
  );

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', router);
  app.use(errorHandler);
  return { app, returns, assets, locations, deviceTypes, movements };
}

/** Stages a return suggestion directly for route tests. */
async function seedReturn(
  returns: InMemoryReturnSuggestionRepository,
  over: { id?: string; serial?: string | null; matchedAssetId?: string | null; status?: 'pending' | 'needs_review' } = {},
) {
  const s = createReturnSuggestion({
    id: over.id ?? 'rs-1',
    taskId: 't1',
    serviceOrderId: 'so-900',
    serialNumber: over.serial === undefined ? 'SN001' : over.serial,
    matchedAssetId: over.matchedAssetId ?? null,
    status: over.status ?? 'pending',
  });
  await returns.create(s);
  return s;
}

describe('GET /api/inventory/depot', () => {
  it('returns 200 with the depot stock DTO shape', async () => {
    const { app } = await buildApp({ canRead: true, seed: true });
    const res = await request(app).get('/api/inventory/depot');

    expect(res.status).toBe(200);
    expect(res.body.depotLocationId).toBe('depot-1');
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0]).toEqual({
      id: 'a1',
      serialNumber: 'SN-A1',
      mac: 'MAC1',
      deviceTypeId: expect.any(String),
      deviceTypeName: 'ONU',
      deviceTypeLabel: 'Optical Unit',
      status: 'available',
      sourceTaskId: 't9',
    });
    expect(res.body.materials).toHaveLength(1);
    expect(res.body.materials[0]).toMatchObject({ name: 'CABLE_UTP', unit: 'm', qty: 42 });
  });

  it('never leaks raw Prisma/entity fields (DTO only)', async () => {
    const { app } = await buildApp({ canRead: true, seed: true });
    const res = await request(app).get('/api/inventory/depot');

    // Entity-only fields that must NOT appear in the DTO
    expect(res.body.assets[0]).not.toHaveProperty('currentLocationId');
    expect(res.body.assets[0]).not.toHaveProperty('source');
    expect(res.body.materials[0]).not.toHaveProperty('locationId');
  });

  it('returns empty shape (depotLocationId=null) when no depot exists', async () => {
    const { app } = await buildApp({ canRead: true, seed: false });
    const res = await request(app).get('/api/inventory/depot');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assets: [], materials: [], depotLocationId: null });
  });

  it('returns 403 without inventory.read permission', async () => {
    const { app } = await buildApp({ canRead: false, seed: true });
    const res = await request(app).get('/api/inventory/depot');
    expect(res.status).toBe(403);
  });
});

describe('Inventory returns routes (EPIC #38 W4)', () => {
  it('GET /returns/pending lists pending + needs_review suggestions (requires inventory.read)', async () => {
    const { app, returns } = await buildApp({ canRead: true, seed: true });
    await seedReturn(returns, { id: 'rs-1', serial: 'SN001', matchedAssetId: 'a1', status: 'pending' });
    await seedReturn(returns, { id: 'rs-2', serial: 'SN-UNK', status: 'needs_review' });

    const res = await request(app).get('/api/inventory/returns/pending');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((r: { id: string }) => r.id).sort()).toEqual(['rs-1', 'rs-2']);
    // DTO only — no entity internals like updatedAt/confirmedMovementId
    expect(res.body[0]).not.toHaveProperty('confirmedMovementId');
  });

  it('GET /returns/pending → 403 without inventory.read', async () => {
    const { app } = await buildApp({ canRead: false, seed: true });
    const res = await request(app).get('/api/inventory/returns/pending');
    expect(res.status).toBe(403);
  });

  it('POST /returns/:id/confirm fires a RETURN, 200, asset shows in depot stock', async () => {
    const { app, returns, assets, locations } = await buildApp({ canRead: true, seed: true });
    const depot = await locations.findByCode('DEPOSITO');
    // an installed asset to return
    await assets.create(createInventoryAsset({
      id: 'a-inst', serialNumber: 'SN-INST', deviceTypeId: 'dt', status: 'installed',
      currentLocationId: 'loc-client', source: 'OCR',
    }));
    await seedReturn(returns, { id: 'rs-1', serial: 'SN-INST', matchedAssetId: 'a-inst', status: 'pending' });

    const res = await request(app).post('/api/inventory/returns/rs-1/confirm').send({ resolution: 'return' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed');
    const asset = await assets.findById('a-inst');
    expect(asset!.status).toBe('available');
    expect(asset!.currentLocationId).toBe(depot!.id);

    const depotRes = await request(app).get('/api/inventory/depot');
    expect(depotRes.body.assets.some((a: { id: string }) => a.id === 'a-inst')).toBe(true);
  });

  it('second POST /returns/:id/confirm → 409 (already resolved)', async () => {
    const { app, returns, assets } = await buildApp({ canRead: true, seed: true });
    await assets.create(createInventoryAsset({
      id: 'a-inst', serialNumber: 'SN-INST', deviceTypeId: 'dt', status: 'installed',
      currentLocationId: 'loc-client', source: 'OCR',
    }));
    await seedReturn(returns, { id: 'rs-1', serial: 'SN-INST', matchedAssetId: 'a-inst', status: 'pending' });

    await request(app).post('/api/inventory/returns/rs-1/confirm').send({ resolution: 'return' });
    const res = await request(app).post('/api/inventory/returns/rs-1/confirm').send({ resolution: 'return' });

    expect(res.status).toBe(409);
  });

  it('POST /returns/:id/confirm → 403 without inventory.write', async () => {
    const { app, returns } = await buildApp({ canRead: true, canWrite: false, seed: true });
    await seedReturn(returns, { id: 'rs-1', status: 'pending' });
    const res = await request(app).post('/api/inventory/returns/rs-1/confirm').send({ resolution: 'discard' });
    expect(res.status).toBe(403);
  });

  it('POST /returns/:id/confirm with bad resolution → 400 validation error', async () => {
    const { app, returns } = await buildApp({ canRead: true, seed: true });
    await seedReturn(returns, { id: 'rs-1', status: 'pending' });
    const res = await request(app).post('/api/inventory/returns/rs-1/confirm').send({ resolution: 'frobnicate' });
    expect(res.status).toBe(400);
  });

  it('POST /returns/:id/confirm on a missing suggestion → 404', async () => {
    const { app } = await buildApp({ canRead: true, seed: true });
    const res = await request(app).post('/api/inventory/returns/nope/confirm').send({ resolution: 'discard' });
    expect(res.status).toBe(404);
  });

  it('POST /returns/:id/discard marks the suggestion discarded', async () => {
    const { app, returns } = await buildApp({ canRead: true, seed: true });
    await seedReturn(returns, { id: 'rs-1', status: 'needs_review', serial: 'SN-UNK' });

    const res = await request(app).post('/api/inventory/returns/rs-1/discard').send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('discarded');
    expect((await returns.get('rs-1'))!.status).toBe('discarded');
  });
});

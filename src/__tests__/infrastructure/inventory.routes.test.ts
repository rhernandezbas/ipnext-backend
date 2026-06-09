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
import { createStockLocation } from '@domain/entities/stock-location';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import { createMaterialStock } from '@domain/entities/material-stock';

async function buildApp(opts: { canRead: boolean; seed?: boolean }) {
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const stock = new InMemoryMaterialStockRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  const materials = new InMemoryMaterialCatalogRepository();

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

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as { user?: { id: string } }).user = { id: 'u1' };
    next();
  };
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  const deny = (_req: Request, res: Response) => res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

  const router = createInventoryRouter(
    new GetDepotStock(locations, assets, stock, deviceTypes, materials),
    auth,
    opts.canRead ? pass : deny,
  );

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', router);
  app.use(errorHandler);
  return app;
}

describe('GET /api/inventory/depot', () => {
  it('returns 200 with the depot stock DTO shape', async () => {
    const app = await buildApp({ canRead: true, seed: true });
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
    const app = await buildApp({ canRead: true, seed: true });
    const res = await request(app).get('/api/inventory/depot');

    // Entity-only fields that must NOT appear in the DTO
    expect(res.body.assets[0]).not.toHaveProperty('currentLocationId');
    expect(res.body.assets[0]).not.toHaveProperty('source');
    expect(res.body.materials[0]).not.toHaveProperty('locationId');
  });

  it('returns empty shape (depotLocationId=null) when no depot exists', async () => {
    const app = await buildApp({ canRead: true, seed: false });
    const res = await request(app).get('/api/inventory/depot');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assets: [], materials: [], depotLocationId: null });
  });

  it('returns 403 without inventory.read permission', async () => {
    const app = await buildApp({ canRead: false, seed: true });
    const res = await request(app).get('/api/inventory/depot');
    expect(res.status).toBe(403);
  });
});

/**
 * contractInventory.transfer.routes.test.ts — seam test para
 * POST /api/contracts/:contractId/inventory/transfer (service-transfer W3).
 *
 * TDD: escrito ANTES de la implementación. Use case REAL + repos in-memory (lección #28).
 *
 * Wire contract:
 *   200 happy ({ moved, items }) · 400 VALIDATION_ERROR (body inválido — zod) ·
 *   403 guard transfer deny (fail-closed, RBAC-1; contractWrite NO alcanza) ·
 *   404 CONTRACT_NOT_FOUND (destino ghost, statusMap del errorHandler global) ·
 *   404 INSTALLED_ITEM_NOT_FOUND (ítem ghost/ajeno) · 409 INSTALLED_ITEM_ALREADY_REMOVED ·
 *   lote ATÓMICO: ante ítem inválido en el lote la respuesta es error y NADA se movió.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';

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
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';
import { ListTaskInventorySuggestions } from '@application/use-cases/ListTaskInventorySuggestions';
import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { CorrectConfirmedDeviceType } from '@application/use-cases/CorrectConfirmedDeviceType';
import { DiscardInventorySuggestion } from '@application/use-cases/DiscardInventorySuggestion';
import { ListContractInstalledItems } from '@application/use-cases/ListContractInstalledItems';
import { ListClientEquipment } from '@application/use-cases/ListClientEquipment';
import { AddContractEquipment } from '@application/use-cases/AddContractEquipment';
import { UpdateInstalledItem } from '@application/use-cases/UpdateInstalledItem';
import { RemoveInstalledItem } from '@application/use-cases/RemoveInstalledItem';
import { RetireInstalledItem } from '@application/use-cases/RetireInstalledItem';
import { RouteAssetToDisposition } from '@application/services/RouteAssetToDisposition';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { ResolveClientLocation } from '@application/use-cases/ResolveClientLocation';
import { RecordMaterialConsumption } from '@application/use-cases/RecordMaterialConsumption';
import { ListTaskMaterialConsumptions } from '@application/use-cases/ListTaskMaterialConsumptions';
import { DeleteMaterialConsumption } from '@application/use-cases/DeleteMaterialConsumption';
import { CreateManualSuggestion } from '@application/use-cases/CreateManualSuggestion';
import { TransferContractEquipment } from '@application/use-cases/TransferContractEquipment';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

const BASE_TYPES = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];

const CONTRACTS: Record<string, { clientId: string; clientName: string | null }> = {
  'C-A': { clientId: 'cli-A', clientName: 'Perez Juan' },
  'C-B': { clientId: 'cli-B', clientName: 'Gomez Ana' },
  'C-X': { clientId: 'cli-X', clientName: 'Otro Cliente' },
};

const makeItem = (over: Partial<ContractInstalledItem> = {}): ContractInstalledItem => ({
  id: 'i1', contractId: 'C-A', type: 'ONU', serialNumber: 'SN-1', mac: null, model: null,
  source: 'MANUAL', sourceTaskId: null, addedByUserId: null, confirmedAt: null,
  status: 'active', notes: null, replacesItemId: null, assetId: null,
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z', ...over,
});

interface Fixture {
  app: express.Express;
  inventory: InMemoryContractInventoryRepository;
  locations: InMemoryStockLocationRepository;
  assets: InMemoryInventoryAssetRepository;
  movements: InMemoryInventoryMovementRepository;
  events: InMemoryContractServiceEventRepository;
}

async function buildApp(opts: { transferAllowed?: boolean; transferGuardWired?: boolean } = {}): Promise<Fixture> {
  const suggestions = new InMemoryInventorySuggestionRepository();
  const inventory = new InMemoryContractInventoryRepository();
  const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());
  const users = new InMemoryRbacUserRepository();
  const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
  for (const name of BASE_TYPES) await catalogRepo.create({ name, active: true, sortOrder: 0 });
  const deviceTypeCatalogService = new DeviceTypeCatalogService(catalogRepo);
  const materialRepo = new InMemoryMaterialCatalogRepository();
  const consumptionRepo = new InMemoryTaskMaterialConsumptionRepository();
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const materialStock = new InMemoryMaterialStockRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, materialStock);
  const uow = new InMemoryUnitOfWork(suggestions, inventory, locations, assets, movements, materialStock);
  const svcCatalog = new InMemoryServiceCatalogRepository();
  await svcCatalog.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
  const events = new InMemoryContractServiceEventRepository();

  const transferEquipment = new TransferContractEquipment(
    inventory,
    { findById: async (id: string) => (id in CONTRACTS ? { id, ...CONTRACTS[id]! } : null) },
    new ResolveClientLocation(locations),
    uow,
    svcCatalog,
    events,
  );

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as { user?: { id: string; username: string } }).user = { id: 'u1', username: 'operador' };
    next();
  };
  const pass: RequestHandler = (_req, _res, next) => next();
  const deny: RequestHandler = (_req, res) => { res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' }); };

  const router = createContractInventoryRouter(
    new ListTaskInventorySuggestions(suggestions, inventory, scheduling),
    new ConfirmInventorySuggestion(suggestions, inventory, scheduling, users, catalogRepo, materialRepo, consumptionRepo),
    new DiscardInventorySuggestion(suggestions),
    new CorrectConfirmedDeviceType(suggestions, inventory),
    new ListContractInstalledItems(inventory, users),
    new ListClientEquipment(inventory),
    new AddContractEquipment(inventory, catalogRepo),
    new UpdateInstalledItem(inventory),
    new RemoveInstalledItem(inventory),
    new RetireInstalledItem(
      inventory,
      new RouteAssetToDisposition(
        new ResolveDepotLocation(locations),
        new ResolveTechnicianLocation(locations),
        new ResolveClientLocation(locations),
      ),
      uow,
      assets,
      movements,
    ),
    new RecordMaterialConsumption(consumptionRepo, materialRepo),
    new ListTaskMaterialConsumptions(consumptionRepo, users),
    new DeleteMaterialConsumption(consumptionRepo),
    auth,
    {
      taskRead: pass, taskWrite: pass, contractRead: pass,
      // contractWrite pass A PROPÓSITO: prueba que transfer NO se cuela por write (RBAC-1 granular).
      contractWrite: pass, materialWrite: pass, manage: pass,
      // transferGuardWired:false — L2: simula una composición SIN perms.transfer (fixture legacy):
      // la ruta debe responder 403 FAIL-CLOSED con el shape real de requirePermission.
      ...(opts.transferGuardWired === false
        ? {}
        : { transfer: (opts.transferAllowed ?? true) ? pass : deny }),
    },
    deviceTypeCatalogService,
    new CreateManualSuggestion(suggestions, scheduling, inventory, deviceTypeCatalogService),
    transferEquipment,
  );

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use(errorHandler);
  return { app, inventory, locations, assets, movements, events };
}

/** Seed: ítem activo de C-A CON asset instalado en la CLIENTE-location de C-A. */
async function seedAssetItem(fx: Fixture, id: string): Promise<void> {
  const clientLoc = await new ResolveClientLocation(fx.locations).execute('C-A');
  const assetId = `asset-${id}`;
  fx.assets.store.set(assetId, createInventoryAsset({
    id: assetId, serialNumber: `SN-${id}`, mac: null, deviceTypeId: 'dt-onu',
    status: 'installed', currentLocationId: clientLoc.id, source: 'MANUAL', sourceTaskId: null,
  }));
  await fx.inventory.create(makeItem({ id, contractId: 'C-A', assetId, serialNumber: `SN-${id}` }));
}

describe('POST /api/contracts/:contractId/inventory/transfer — happy path', () => {
  it('200: mueve el lote, registra TRANSFER del asset y responde { moved, items }', async () => {
    const fx = await buildApp();
    await seedAssetItem(fx, 'it-asset');
    await fx.inventory.create(makeItem({ id: 'it-bare', contractId: 'C-A', type: 'ROUTER', serialNumber: 'RT-1' }));

    const res = await request(fx.app)
      .post('/api/contracts/C-A/inventory/transfer')
      .send({ targetContractId: 'C-B', itemIds: ['it-asset', 'it-bare'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      moved: 2,
      items: [
        { id: 'it-asset', type: 'ONU', assetMoved: true },
        { id: 'it-bare', type: 'ROUTER', assetMoved: false },
      ],
    });

    expect((await fx.inventory.getById('it-asset'))!.contractId).toBe('C-B');
    expect((await fx.inventory.getById('it-bare'))!.contractId).toBe('C-B');

    const targetLoc = await fx.locations.findByTypeAndContract('CLIENTE', 'C-B');
    expect(fx.movements.movements).toHaveLength(1);
    expect(fx.movements.movements[0]!.toLocationId).toBe(targetLoc!.id);
    expect((await fx.assets.findById('asset-it-asset'))!.currentLocationId).toBe(targetLoc!.id);

    // Seam completo: eventos out/in grabados con el actor del request.
    const kinds = fx.events.all().map(e => e.changeKind).sort();
    expect(kinds).toEqual(['transfer-in', 'transfer-out']);
    expect(fx.events.all().every(e => e.actorId === 'u1' && e.actorName === 'operador')).toBe(true);
  });
});

describe('POST /api/contracts/:contractId/inventory/transfer — validación y errores', () => {
  it('400 VALIDATION_ERROR con body inválido (sin targetContractId)', async () => {
    const fx = await buildApp();
    const res = await request(fx.app)
      .post('/api/contracts/C-A/inventory/transfer')
      .send({ itemIds: ['x'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR con itemIds vacío', async () => {
    const fx = await buildApp();
    const res = await request(fx.app)
      .post('/api/contracts/C-A/inventory/transfer')
      .send({ targetContractId: 'C-B', itemIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400 VALIDATION_ERROR cuando target == source, sin efectos', async () => {
    const fx = await buildApp();
    await seedAssetItem(fx, 'it-1');
    const res = await request(fx.app)
      .post('/api/contracts/C-A/inventory/transfer')
      .send({ targetContractId: 'C-A', itemIds: ['it-1'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect((await fx.inventory.getById('it-1'))!.contractId).toBe('C-A');
  });

  it('404 CONTRACT_NOT_FOUND cuando el contrato destino no existe (errorHandler global)', async () => {
    const fx = await buildApp();
    await seedAssetItem(fx, 'it-1');
    const res = await request(fx.app)
      .post('/api/contracts/C-A/inventory/transfer')
      .send({ targetContractId: 'ghost', itemIds: ['it-1'] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONTRACT_NOT_FOUND');
  });

  it('404 INSTALLED_ITEM_NOT_FOUND cuando un ítem no existe', async () => {
    const fx = await buildApp();
    const res = await request(fx.app)
      .post('/api/contracts/C-A/inventory/transfer')
      .send({ targetContractId: 'C-B', itemIds: ['ghost'] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INSTALLED_ITEM_NOT_FOUND');
  });

  it('409 INSTALLED_ITEM_ALREADY_REMOVED cuando un ítem del lote está inactivo', async () => {
    const fx = await buildApp();
    await fx.inventory.create(makeItem({ id: 'it-removed', contractId: 'C-A', status: 'removed' }));
    const res = await request(fx.app)
      .post('/api/contracts/C-A/inventory/transfer')
      .send({ targetContractId: 'C-B', itemIds: ['it-removed'] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSTALLED_ITEM_ALREADY_REMOVED');
  });

  it('lote ATÓMICO: ítem ajeno en el lote → 404 y NADA se movió (cero movimientos, cero eventos)', async () => {
    const fx = await buildApp();
    await seedAssetItem(fx, 'it-ok');
    await fx.inventory.create(makeItem({ id: 'it-ajeno', contractId: 'C-X' }));

    const res = await request(fx.app)
      .post('/api/contracts/C-A/inventory/transfer')
      .send({ targetContractId: 'C-B', itemIds: ['it-ok', 'it-ajeno'] });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INSTALLED_ITEM_NOT_FOUND');
    expect((await fx.inventory.getById('it-ok'))!.contractId).toBe('C-A');
    expect((await fx.inventory.getById('it-ajeno'))!.contractId).toBe('C-X');
    expect(fx.movements.movements).toHaveLength(0);
    expect(fx.events.all()).toHaveLength(0);
  });
});

describe('POST /api/contracts/:contractId/inventory/transfer — RBAC (RBAC-1)', () => {
  it('403 sin inventory.transfer (contractWrite NO alcanza, fail-closed) y sin efectos', async () => {
    const fx = await buildApp({ transferAllowed: false });
    await seedAssetItem(fx, 'it-1');

    const res = await request(fx.app)
      .post('/api/contracts/C-A/inventory/transfer')
      .send({ targetContractId: 'C-B', itemIds: ['it-1'] });

    expect(res.status).toBe(403);
    expect((await fx.inventory.getById('it-1'))!.contractId).toBe('C-A');
    expect(fx.movements.movements).toHaveLength(0);
    expect(fx.events.all()).toHaveLength(0);
  });

  // fix wave L2 — composición SIN perms.transfer wired (fixture legacy / wiring incompleto):
  // el fallback de la ruta es FAIL-CLOSED y su body espeja el shape real de requirePermission
  // (code PERMISSION_DENIED), para que el FE trate ambos denies igual.
  it('L2: router construido SIN perms.transfer → 403 fail-closed con code PERMISSION_DENIED y sin efectos', async () => {
    const fx = await buildApp({ transferGuardWired: false });
    await seedAssetItem(fx, 'it-1');

    const res = await request(fx.app)
      .post('/api/contracts/C-A/inventory/transfer')
      .send({ targetContractId: 'C-B', itemIds: ['it-1'] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect((await fx.inventory.getById('it-1'))!.contractId).toBe('C-A');
    expect(fx.movements.movements).toHaveLength(0);
    expect(fx.events.all()).toHaveLength(0);
  });
});

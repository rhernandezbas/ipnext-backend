/**
 * EPIC #38 W6 — Material deduction routes integration tests.
 *
 * These tests follow the exact same pattern as inventory.routes.test.ts (W4).
 * All repos are in-memory; no Prisma involved.
 *
 * Scenarios covered:
 *   SCEN-PG-1  GET /deductions/pending requires inventory.read → 403 without it
 *   SCEN-PG-2  POST /deductions/:id/confirm requires inventory.write → 403 without it
 *   SCEN-PG-3  GET /deductions/pending returns pending + needs_review DTOs (no raw entity fields)
 *   SCEN-PG-4  POST /deductions/:id/confirm with resolution=discard → 200, status=discarded
 *   SCEN-PG-5  Double-confirm → 409 DEDUCTION_ALREADY_CONFIRMED (W4 regression guard)
 *   SCEN-PG-6  POST /deductions/:id/discard → 200, status=discarded
 *   SCEN-PG-7  POST /deductions/:id/confirm on unknown id → 404
 */
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
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryReturnSuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryReturnSuggestionRepository';
import { InMemoryMaterialDeductionSuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialDeductionSuggestionRepository';
import { InMemoryTaskMaterialConsumptionRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskMaterialConsumptionRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';

import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { GetTechnicianStock } from '@application/use-cases/GetTechnicianStock';
import { IssueStockToTechnician } from '@application/use-cases/IssueStockToTechnician';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { ListPendingReturns } from '@application/use-cases/ListPendingReturns';
import { ConfirmAssetReturn } from '@application/use-cases/ConfirmAssetReturn';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { ListPendingDeductions } from '@application/use-cases/ListPendingDeductions';
import { ConfirmMaterialDeduction } from '@application/use-cases/ConfirmMaterialDeduction';

import { createStockLocation } from '@domain/entities/stock-location';
import { createMaterialDeductionSuggestion } from '@domain/entities/material-deduction-suggestion';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDeduction(
  over: Partial<Parameters<typeof createMaterialDeductionSuggestion>[0]> & { id?: string } = {},
) {
  return createMaterialDeductionSuggestion({
    id: over.id ?? 'ds-1',
    taskMaterialConsumptionId: over.taskMaterialConsumptionId ?? 'cons-1',
    taskId: over.taskId ?? 'task-1',
    technicianId: over.technicianId ?? 'tech-1',
    materialCatalogId: over.materialCatalogId ?? 'mat-1',
    qty: over.qty ?? 2,
    technicianLocationId: over.technicianLocationId ?? 'loc-tech',
    status: over.status ?? 'pending',
  });
}

async function buildApp(opts: { canRead: boolean; canWrite?: boolean; seed?: boolean }) {
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const stock = new InMemoryMaterialStockRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  const materials = new InMemoryMaterialCatalogRepository();
  // FIX 6 — enrichment repos
  const materialCatalog = new InMemoryMaterialCatalogRepository();
  const rbacUsers = new InMemoryRbacUserRepository();
  const schedulingRepo = new InMemorySchedulingRepository();
  const returns = new InMemoryReturnSuggestionRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, stock);
  const deductions = new InMemoryMaterialDeductionSuggestionRepository();
  const consumptions = new InMemoryTaskMaterialConsumptionRepository();

  await deviceTypes.create({ name: 'OTROS', active: true, sortOrder: 9 });

  if (opts.seed) {
    await locations.create(createStockLocation({ id: 'depot-1', type: 'DEPOSITO', code: 'DEPOSITO' }));
  }

  const suggestions = new InMemoryInventorySuggestionRepository();
  const contractInv = new InMemoryContractInventoryRepository();
  const uow = new InMemoryUnitOfWork(
    suggestions,
    contractInv,
    locations,
    assets,
    movements,
    stock,
    returns,
    deductions,
    consumptions,
  );

  const resolveDepot = new ResolveDepotLocation(locations);

  const confirm = new ConfirmAssetReturn(
    returns, assets, movements, locations, deviceTypes, resolveDepot, uow,
  );

  const confirmDeduction = new ConfirmMaterialDeduction(
    deductions,
    consumptions,
    movements,
    stock,
    locations,
    resolveDepot,
    uow,
  );

  const auth = (req: Request, _res: Response, next: NextFunction) => {
    (req as { user?: { id: string } }).user = { id: 'u1' };
    next();
  };
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  const deny = (_req: Request, res: Response) =>
    res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });

  const issueStock = new IssueStockToTechnician(
    resolveDepot,
    new ResolveTechnicianLocation(locations),
    assets,
    uow,
  );

  const router = createInventoryRouter(
    new GetDepotStock(locations, assets, stock, deviceTypes, materials),
    new ListPendingReturns(returns),
    confirm,
    new GetTechnicianStock(locations, assets, stock, deviceTypes, materials),
    issueStock,
    auth,
    opts.canRead ? pass : deny,
    (opts.canWrite ?? true) ? pass : deny,
    new ListPendingDeductions(deductions, materialCatalog, rbacUsers, schedulingRepo),
    confirmDeduction,
  );

  const app = express();
  app.use(express.json());
  app.use('/api/inventory', router);
  app.use(errorHandler);

  return { app, deductions, movements, stock, locations, materialCatalog, rbacUsers, schedulingRepo };
}

// ── test suites ───────────────────────────────────────────────────────────────

describe('Material deduction routes (EPIC #38 W6)', () => {
  describe('SCEN-PG-1  GET /deductions/pending', () => {
    it('returns 403 without inventory.read', async () => {
      const { app } = await buildApp({ canRead: false });
      const res = await request(app).get('/api/inventory/deductions/pending');
      expect(res.status).toBe(403);
    });

    it('returns 200 with pending + needs_review DTOs (no raw entity fields)', async () => {
      const { app, deductions } = await buildApp({ canRead: true });
      await deductions.create(makeDeduction({ id: 'ds-1', status: 'pending' }));
      await deductions.create(makeDeduction({ id: 'ds-2', taskMaterialConsumptionId: 'cons-2', status: 'needs_review' }));
      // confirmed ones should NOT appear
      await deductions.create(makeDeduction({ id: 'ds-3', taskMaterialConsumptionId: 'cons-3', status: 'confirmed' }));

      const res = await request(app).get('/api/inventory/deductions/pending');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      const ids = res.body.map((d: { id: string }) => d.id).sort();
      expect(ids).toEqual(['ds-1', 'ds-2']);

      // FIX 6: DTO shape matches FE contract
      const first = res.body[0];
      expect(first).not.toHaveProperty('sourceRef');
      expect(first).not.toHaveProperty('taskMaterialConsumptionId'); // renamed to consumptionId
      expect(first).not.toHaveProperty('materialCatalogId'); // renamed to materialId
      expect(first).toHaveProperty('consumptionId');  // FE contract field
      expect(first).toHaveProperty('materialId');     // FE contract field
      expect(first).toHaveProperty('materialName');   // FE contract field
      expect(first).toHaveProperty('technicianName'); // FE contract field
      expect(first).toHaveProperty('taskSeq');        // FE contract field
      expect(first).toHaveProperty('taskTitle');      // FE contract field
      expect(first).toHaveProperty('qty');
      expect(first).toHaveProperty('status');
      expect(first).toHaveProperty('createdAt');
    });

    it('FIX-6: enriched DTO contains resolved materialName, technicianName, taskSeq', async () => {
      const { app, deductions, materialCatalog, rbacUsers, schedulingRepo } =
        await buildApp({ canRead: true });

      // Seed enrichment data
      await materialCatalog.create({ name: 'Cable UTP', unit: 'm', active: true, sortOrder: 1 });
      const mat = (await materialCatalog.list())[0];

      // Create a user in the rbac user repo
      const user = await rbacUsers.create({
        name: 'Juan Técnico',
        email: 'juan@example.com',
        login: 'juan',
        passwordHash: 'x',
      });

      // Use task '1' (pre-seeded, sequenceNumber=1, title='Instalación fibra óptica - García')
      // to avoid ID collision with the InMemorySchedulingRepository's module-level counter.
      const existingTask = await schedulingRepo.getTask('1');
      expect(existingTask).not.toBeNull();

      await deductions.create(createMaterialDeductionSuggestion({
        id: 'ds-enrich',
        taskMaterialConsumptionId: 'cons-enrich',
        taskId: '1',
        technicianId: user.id,
        materialCatalogId: mat.id,
        qty: 3,
        status: 'pending',
      }));

      const res = await request(app).get('/api/inventory/deductions/pending');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);

      const dto = res.body[0];
      expect(dto.consumptionId).toBe('cons-enrich');
      expect(dto.materialId).toBe(mat.id);
      expect(dto.materialName).toBe('Cable UTP');
      expect(dto.materialUnit).toBe('m');
      expect(dto.technicianName).toBe('Juan Técnico');
      expect(dto.taskSeq).toBe(1); // task '1' has sequenceNumber 1
      expect(dto.taskTitle).toBe('Instalación fibra óptica - García');
    });
  });

  describe('SCEN-PG-2  POST /deductions/:id/confirm', () => {
    it('returns 403 without inventory.write', async () => {
      const { app, deductions } = await buildApp({ canRead: true, canWrite: false, seed: true });
      await deductions.create(makeDeduction({ id: 'ds-1', status: 'pending' }));
      const res = await request(app)
        .post('/api/inventory/deductions/ds-1/confirm')
        .send({ resolution: 'discard' });
      expect(res.status).toBe(403);
    });

    it('discard → 200, status=discarded', async () => {
      const { app, deductions } = await buildApp({ canRead: true, seed: true });
      await deductions.create(makeDeduction({ id: 'ds-1', status: 'pending' }));

      const res = await request(app)
        .post('/api/inventory/deductions/ds-1/confirm')
        .send({ resolution: 'discard' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('discarded');
    });

    it('deduct with sufficient stock → 200, movement written', async () => {
      const { app, deductions, stock, movements } = await buildApp({ canRead: true, seed: true });
      // provision tech location and stock
      const { locations } = await buildApp({ canRead: true, seed: true }); // fresh for location seed — reuse

      // Use the original app's repos instead (they share via closure in buildApp)
      // We need to seed tech location directly
      const { app: app2, deductions: deductions2, stock: stock2, movements: movements2, locations: locs2 } =
        await buildApp({ canRead: true, seed: true });

      await locs2.create(createStockLocation({ id: 'loc-tech', type: 'TECNICO', code: 'TECNICO-tech-1', technicianId: 'tech-1' }));
      const { InMemoryMaterialStockRepository: _ } = await import('@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository');
      const { createMaterialStock } = await import('@domain/entities/material-stock');
      await stock2.upsert(createMaterialStock({ id: 'ms-1', materialCatalogId: 'mat-1', locationId: 'loc-tech', qty: 10 }));

      await deductions2.create(makeDeduction({
        id: 'ds-1',
        technicianLocationId: 'loc-tech',
        qty: 2,
        status: 'pending',
      }));

      const res = await request(app2)
        .post('/api/inventory/deductions/ds-1/confirm')
        .send({ resolution: 'deduct' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('confirmed');
      expect(movements2.movements.some((m: { type: string }) => m.type === 'CONSUME')).toBe(true);
    });

    it('bad resolution → 400 validation error', async () => {
      const { app, deductions } = await buildApp({ canRead: true, seed: true });
      await deductions.create(makeDeduction({ id: 'ds-1', status: 'pending' }));
      const res = await request(app)
        .post('/api/inventory/deductions/ds-1/confirm')
        .send({ resolution: 'frobnicate' });
      expect(res.status).toBe(400);
    });

    it('unknown suggestion id → 404', async () => {
      const { app } = await buildApp({ canRead: true, seed: true });
      const res = await request(app)
        .post('/api/inventory/deductions/nope/confirm')
        .send({ resolution: 'discard' });
      expect(res.status).toBe(404);
    });
  });

  describe('SCEN-PG-5  Double-confirm → 409 (W4 regression guard)', () => {
    it('second confirm after discard → 409 DEDUCTION_ALREADY_CONFIRMED', async () => {
      const { app, deductions } = await buildApp({ canRead: true, seed: true });
      await deductions.create(makeDeduction({ id: 'ds-1', status: 'pending' }));

      // first confirm (discard — no movement needed)
      await request(app).post('/api/inventory/deductions/ds-1/confirm').send({ resolution: 'discard' });

      // second confirm
      const res = await request(app)
        .post('/api/inventory/deductions/ds-1/confirm')
        .send({ resolution: 'discard' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DEDUCTION_ALREADY_CONFIRMED');
    });
  });

  describe('FIX-5  issue-first with null technicianLocation → 409 DEDUCTION_NO_TECHNICIAN', () => {
    it('confirm with resolution=issue-first and no technicianLocationId → 409', async () => {
      const { app, deductions } = await buildApp({ canRead: true, seed: true });

      // Bypass makeDeduction (its ?? guard would substitute 'loc-tech' for null).
      // Directly seed a suggestion with technicianLocationId explicitly null.
      await deductions.create(createMaterialDeductionSuggestion({
        id: 'ds-fix5',
        taskMaterialConsumptionId: 'cons-fix5',
        taskId: 'task-fix5',
        technicianId: 'tech-fix5',
        materialCatalogId: 'mat-1',
        qty: 2,
        technicianLocationId: null,
        status: 'needs_review',
      }));

      const res = await request(app)
        .post('/api/inventory/deductions/ds-fix5/confirm')
        .send({ resolution: 'issue-first' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DEDUCTION_NO_TECHNICIAN');
    });
  });

  describe('FIX-3  depot resolution with zero depot stock → 409 INSUFFICIENT_STOCK', () => {
    it('confirm with resolution=depot when depot has zero stock → 409 INSUFFICIENT_STOCK', async () => {
      const { app, deductions, locations } = await buildApp({ canRead: true, seed: true });

      // seed a suggestion pointing to depot resolution path (no technicianLocationId needed)
      await deductions.create(makeDeduction({
        id: 'ds-depot-0',
        taskMaterialConsumptionId: 'cons-depot-0',
        technicianLocationId: null,
        qty: 5,
        status: 'needs_review',
      }));
      // depot-1 exists (seed: true), but NO stock row for mat-1 at depot-1 → qty=0 → insufficient

      const res = await request(app)
        .post('/api/inventory/deductions/ds-depot-0/confirm')
        .send({ resolution: 'depot' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INSUFFICIENT_STOCK');
    });
  });

  describe('SCEN-PG-6  POST /deductions/:id/discard', () => {
    it('returns 200, status=discarded', async () => {
      const { app, deductions } = await buildApp({ canRead: true, seed: true });
      await deductions.create(makeDeduction({ id: 'ds-1', status: 'needs_review' }));

      const res = await request(app).post('/api/inventory/deductions/ds-1/discard').send({});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('discarded');
    });

    it('returns 403 without inventory.write', async () => {
      const { app, deductions } = await buildApp({ canRead: true, canWrite: false, seed: true });
      await deductions.create(makeDeduction({ id: 'ds-1', status: 'pending' }));
      const res = await request(app).post('/api/inventory/deductions/ds-1/discard').send({});
      expect(res.status).toBe(403);
    });
  });
});

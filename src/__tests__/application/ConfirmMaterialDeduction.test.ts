/**
 * ConfirmMaterialDeduction — TDD unit tests (EPIC #38 W6)
 *
 * Covers: SCEN-CF-1, SCEN-CF-2, SCEN-CF-3, SCEN-CF-4, SCEN-NR-1, SCEN-NR-2, SCEN-NR-3
 * Layer: Unit — in-memory UoW, no supertest.
 */

import { ConfirmMaterialDeduction, DeductionResolution } from '@application/use-cases/ConfirmMaterialDeduction';
import { InMemoryMaterialDeductionSuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialDeductionSuggestionRepository';
import { InMemoryTaskMaterialConsumptionRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskMaterialConsumptionRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import {
  createMaterialDeductionSuggestion,
  MaterialDeductionSuggestion,
} from '@domain/entities/material-deduction-suggestion';
import { createStockLocation } from '@domain/entities/stock-location';
import { randomUUID } from 'crypto';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';

async function buildSetup() {
  const deductions = new InMemoryMaterialDeductionSuggestionRepository();
  const consumptions = new InMemoryTaskMaterialConsumptionRepository();
  const stock = new InMemoryMaterialStockRepository();
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, stock);
  const suggestions = new InMemoryInventorySuggestionRepository();
  const contractInv = new InMemoryContractInventoryRepository();

  // Create DEPOSITO location
  const depot = await locations.create(
    createStockLocation({ id: 'depot-1', type: 'DEPOSITO', code: 'DEPOSITO' }),
  );

  const uow = new InMemoryUnitOfWork(
    suggestions,
    contractInv,
    locations,
    assets,
    movements,
    stock,
    undefined, // no returns
    deductions,
    consumptions,
  );

  const resolveDepot = new ResolveDepotLocation(locations);

  const useCase = new ConfirmMaterialDeduction(
    deductions,
    consumptions,
    movements,
    stock,
    locations,
    resolveDepot,
    uow,
  );

  return { deductions, consumptions, stock, locations, assets, movements, useCase, depot };
}

async function seedTechLocation(
  locations: InMemoryStockLocationRepository,
  technicianId: string,
): Promise<string> {
  const loc = await locations.create(
    createStockLocation({ id: `loc-tech-${technicianId}`, type: 'TECNICO', technicianId }),
  );
  return loc.id;
}

async function seedSuggestion(
  deductions: InMemoryMaterialDeductionSuggestionRepository,
  overrides: Partial<MaterialDeductionSuggestion> = {},
): Promise<MaterialDeductionSuggestion> {
  const s = createMaterialDeductionSuggestion({
    id: overrides.id ?? randomUUID(),
    taskMaterialConsumptionId: overrides.taskMaterialConsumptionId ?? randomUUID(),
    taskId: overrides.taskId ?? 'task-1',
    technicianId: overrides.technicianId ?? 'tech-1',
    materialCatalogId: overrides.materialCatalogId ?? 'mat-1',
    qty: overrides.qty ?? 3,
    technicianLocationId: overrides.technicianLocationId ?? 'loc-tech-tech-1',
    status: overrides.status ?? 'pending',
  });
  // Directly set into store to support all statuses including confirmed
  deductions.store.set(s.id, { ...s, ...overrides });
  return { ...s, ...overrides };
}

async function seedConsumption(
  consumptions: InMemoryTaskMaterialConsumptionRepository,
  id: string,
  taskId = 'task-1',
  materialCatalogId = 'mat-1',
  quantity = 3,
) {
  const c = {
    id,
    taskId,
    materialCatalogId,
    materialName: 'Material Test',
    quantity,
    unit: null,
    notes: null,
    recordedByUserId: null,
    deductedAt: null,
    deductedMovementId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  consumptions.store.set(id, c);
  return c;
}

// ── SCEN-CF-1: pending → confirmed + stock decremented atomically ─────────────

test('SCEN-CF-1: confirm pending suggestion decrements stock and stamps consumption', async () => {
  const { deductions, consumptions, stock, useCase } = await buildSetup();

  const techLocationId = 'loc-tech-tech-1';
  const consumptionId = 'cons-cf1';
  const suggestionId = 'sug-cf1';
  const materialId = 'mat-1';

  await stock.upsert({ id: randomUUID(), materialCatalogId: materialId, locationId: techLocationId, qty: 10 });
  await seedConsumption(consumptions, consumptionId, 'task-1', materialId, 3);
  await seedSuggestion(deductions, {
    id: suggestionId,
    taskMaterialConsumptionId: consumptionId,
    technicianLocationId: techLocationId,
    materialCatalogId: materialId,
    qty: 3,
    status: 'pending',
  });

  const result = await useCase.execute({ suggestionId, resolution: 'deduct' });

  expect(result.status).toBe('confirmed');
  expect(result.resolution).toBe('deduct');
  expect(result.deductedMovementId).not.toBeNull();
  expect(result.sourceRef).toBe(`consume:task-material:${consumptionId}`);

  // stock decremented
  const stockAfter = await stock.findByMaterialAndLocation(materialId, techLocationId);
  expect(stockAfter!.qty).toBe(7);

  // consumption stamped
  const cons = await consumptions.findById(consumptionId);
  expect(cons!.deductedAt).not.toBeNull();
  expect(cons!.deductedMovementId).not.toBeNull();
});

// ── SCEN-CF-2: TOCTOU — stock dropped between stage and confirm ───────────────

test('SCEN-CF-2: TOCTOU flips suggestion to needs_review without mutating stock', async () => {
  const { deductions, consumptions, stock, useCase } = await buildSetup();

  const techLocationId = 'loc-tech-tech-1';
  const consumptionId = 'cons-cf2';
  const suggestionId = 'sug-cf2';
  const materialId = 'mat-2';

  // Stock was 5 at stage time but dropped to 1 before confirm
  await stock.upsert({ id: randomUUID(), materialCatalogId: materialId, locationId: techLocationId, qty: 1 });
  await seedConsumption(consumptions, consumptionId, 'task-1', materialId, 3);
  await seedSuggestion(deductions, {
    id: suggestionId,
    taskMaterialConsumptionId: consumptionId,
    technicianLocationId: techLocationId,
    materialCatalogId: materialId,
    qty: 3,
    status: 'pending', // was staged as pending (stock was sufficient then)
  });

  const result = await useCase.execute({ suggestionId, resolution: 'deduct' });

  // Flipped to needs_review — no movement
  expect(result.status).toBe('needs_review');

  // stock NOT decremented
  const stockAfter = await stock.findByMaterialAndLocation(materialId, techLocationId);
  expect(stockAfter!.qty).toBe(1);
});

// ── SCEN-CF-3: double-confirm → 409 ──────────────────────────────────────────

test('SCEN-CF-3: double-confirm throws DeductionAlreadyConfirmedError', async () => {
  const { deductions, consumptions, stock, useCase } = await buildSetup();

  const techLocationId = 'loc-tech-tech-1';
  const consumptionId = 'cons-cf3';
  const suggestionId = 'sug-cf3';
  const materialId = 'mat-3';

  await stock.upsert({ id: randomUUID(), materialCatalogId: materialId, locationId: techLocationId, qty: 10 });
  await seedConsumption(consumptions, consumptionId, 'task-1', materialId, 2);
  await seedSuggestion(deductions, {
    id: suggestionId,
    taskMaterialConsumptionId: consumptionId,
    technicianLocationId: techLocationId,
    materialCatalogId: materialId,
    qty: 2,
    status: 'confirmed',  // already terminal
    sourceRef: `consume:task-material:${consumptionId}`,
  });

  await expect(useCase.execute({ suggestionId, resolution: 'deduct' })).rejects.toMatchObject({
    code: 'DEDUCTION_ALREADY_CONFIRMED',
  });
});

// ── SCEN-CF-4: never-negative guard ──────────────────────────────────────────

test('SCEN-CF-4: never-negative — qty=3 > stock=2 → TOCTOU flips to needs_review', async () => {
  const { deductions, consumptions, stock, useCase } = await buildSetup();

  const techLocationId = 'loc-tech-tech-1';
  const consumptionId = 'cons-cf4';
  const suggestionId = 'sug-cf4';
  const materialId = 'mat-4';

  await stock.upsert({ id: randomUUID(), materialCatalogId: materialId, locationId: techLocationId, qty: 2 });
  await seedConsumption(consumptions, consumptionId, 'task-1', materialId, 5);
  await seedSuggestion(deductions, {
    id: suggestionId,
    taskMaterialConsumptionId: consumptionId,
    technicianLocationId: techLocationId,
    materialCatalogId: materialId,
    qty: 5,
    status: 'pending',
  });

  const result = await useCase.execute({ suggestionId, resolution: 'deduct' });

  expect(result.status).toBe('needs_review');
  const stockAfter = await stock.findByMaterialAndLocation(materialId, techLocationId);
  expect(stockAfter!.qty).toBe(2); // unchanged
});

// ── SCEN-NR-1: issue-first → TRANSFER + CONSUME ──────────────────────────────

test('SCEN-NR-1: issue-first creates TRANSFER depot→tecnico AND CONSUME tecnico', async () => {
  const { deductions, consumptions, stock, locations, movements, depot, useCase } = await buildSetup();

  const technicianId = 'tech-nr1';
  const techLocationId = await (async () => {
    const loc = await locations.create(
      createStockLocation({ id: `loc-tech-${technicianId}`, type: 'TECNICO', technicianId }),
    );
    return loc.id;
  })();

  const materialId = 'mat-nr1';
  const consumptionId = 'cons-nr1';
  const suggestionId = 'sug-nr1';

  // depot has stock, technician has none
  await stock.upsert({ id: randomUUID(), materialCatalogId: materialId, locationId: depot.id, qty: 10 });
  await stock.upsert({ id: randomUUID(), materialCatalogId: materialId, locationId: techLocationId, qty: 0 });
  await seedConsumption(consumptions, consumptionId, 'task-nr1', materialId, 3);
  await seedSuggestion(deductions, {
    id: suggestionId,
    taskMaterialConsumptionId: consumptionId,
    technicianId,
    technicianLocationId: techLocationId,
    materialCatalogId: materialId,
    qty: 3,
    status: 'needs_review',
  });

  const result = await useCase.execute({ suggestionId, resolution: 'issue-first' });

  expect(result.status).toBe('confirmed');
  expect(result.resolution).toBe('issue-first');

  // Two movements created: TRANSFER + CONSUME
  const allMovements = movements.movements;
  const transfer = allMovements.find(m => m.type === 'TRANSFER');
  const consume = allMovements.find(m => m.type === 'CONSUME');
  expect(transfer).toBeDefined();
  expect(consume).toBeDefined();
  expect(transfer!.fromLocationId).toBe(depot.id);
  expect(transfer!.toLocationId).toBe(techLocationId);
  expect(consume!.fromLocationId).toBe(techLocationId);

  // depot decremented, tecnico net unchanged (FIX-7e: TRANSFER in + CONSUME out = 0 net change)
  const depotStock = await stock.findByMaterialAndLocation(materialId, depot.id);
  expect(depotStock!.qty).toBe(7); // 10 - 3
  // FIX-7e assertion: technician stock must be net-unchanged (was 0, TRANSFER +3, CONSUME -3 = 0)
  const techStock = await stock.findByMaterialAndLocation(materialId, techLocationId);
  expect(techStock!.qty).toBe(0); // TRANSFER(+3) then CONSUME(-3) = net 0
});

// ── SCEN-NR-2: depot → CONSUME from depot ────────────────────────────────────

test('SCEN-NR-2: depot resolution creates CONSUME from depot', async () => {
  const { deductions, consumptions, stock, depot, movements, useCase } = await buildSetup();

  const materialId = 'mat-nr2';
  const consumptionId = 'cons-nr2';
  const suggestionId = 'sug-nr2';

  await stock.upsert({ id: randomUUID(), materialCatalogId: materialId, locationId: depot.id, qty: 8 });
  await seedConsumption(consumptions, consumptionId, 'task-nr2', materialId, 2);
  await seedSuggestion(deductions, {
    id: suggestionId,
    taskMaterialConsumptionId: consumptionId,
    materialCatalogId: materialId,
    qty: 2,
    status: 'needs_review',
  });

  const result = await useCase.execute({ suggestionId, resolution: 'depot' });

  expect(result.status).toBe('confirmed');
  expect(result.resolution).toBe('depot');

  const consume = movements.movements.find(m => m.type === 'CONSUME');
  expect(consume).toBeDefined();
  expect(consume!.fromLocationId).toBe(depot.id);

  const depotStock = await stock.findByMaterialAndLocation(materialId, depot.id);
  expect(depotStock!.qty).toBe(6);
});

// ── FIX 4 — status-guarded updateStatus (discard/confirm race) ───────────────

test('FIX-4a: discard after confirmed → DeductionAlreadyConfirmedError', async () => {
  const { deductions, consumptions, useCase } = await buildSetup();

  const consumptionId = 'cons-fix4a';
  const suggestionId = 'sug-fix4a';
  await seedConsumption(consumptions, consumptionId, 'task-fix4a', 'mat-fix4a', 1);
  // Seed as already-confirmed (terminal)
  await seedSuggestion(deductions, {
    id: suggestionId,
    taskMaterialConsumptionId: consumptionId,
    materialCatalogId: 'mat-fix4a',
    qty: 1,
    status: 'confirmed',
    resolution: 'deduct',
    sourceRef: `consume:task-material:${consumptionId}`,
  });

  // Trying to discard a confirmed suggestion should throw
  await expect(useCase.execute({ suggestionId, resolution: 'discard' })).rejects.toMatchObject({
    code: 'DEDUCTION_ALREADY_CONFIRMED',
  });
});

test('FIX-4b: direct updateStatus on confirmed row returns null (guard)', async () => {
  const deductions = new InMemoryMaterialDeductionSuggestionRepository();
  const consumptionId = 'cons-fix4b';
  const suggestionId = 'sug-fix4b';

  // Seed as confirmed
  const s = createMaterialDeductionSuggestion({
    id: suggestionId,
    taskMaterialConsumptionId: consumptionId,
    taskId: 'task-fix4b',
    materialCatalogId: 'mat-fix4b',
    qty: 1,
    status: 'confirmed',
  });
  deductions.store.set(s.id, { ...s, status: 'confirmed', resolution: 'deduct', sourceRef: `consume:task-material:${consumptionId}` });

  // updateStatus to discarded on a confirmed row → null (guard wins)
  const result = await deductions.updateStatus(suggestionId, { status: 'discarded', resolution: 'discard' });
  expect(result).toBeNull();
});

// ── SCEN-NR-3: discard → no movement, status discarded ───────────────────────

test('SCEN-NR-3: discard closes suggestion with no movement', async () => {
  const { deductions, consumptions, useCase, movements } = await buildSetup();

  const consumptionId = 'cons-nr3';
  const suggestionId = 'sug-nr3';

  await seedConsumption(consumptions, consumptionId, 'task-nr3', 'mat-nr3', 1);
  await seedSuggestion(deductions, {
    id: suggestionId,
    taskMaterialConsumptionId: consumptionId,
    materialCatalogId: 'mat-nr3',
    qty: 1,
    status: 'needs_review',
  });

  const result = await useCase.execute({ suggestionId, resolution: 'discard' });

  expect(result.status).toBe('discarded');
  expect(result.resolution).toBe('discard');
  expect(movements.movements).toHaveLength(0);
});

// ── FIX 5 — issue-first with null technicianLocation must 4xx ─────────────────

test('FIX-5 unit: issue-first with null technicianLocationId throws DeductionHasNoTechnicianError', async () => {
  const { deductions, consumptions, useCase } = await buildSetup();

  const consumptionId = 'cons-fix5';
  const suggestionId = 'sug-fix5';

  await seedConsumption(consumptions, consumptionId, 'task-fix5', 'mat-fix5', 2);
  await seedSuggestion(deductions, {
    id: suggestionId,
    taskMaterialConsumptionId: consumptionId,
    materialCatalogId: 'mat-fix5',
    qty: 2,
    status: 'needs_review',
    technicianLocationId: null, // no tech location
  });

  await expect(useCase.execute({ suggestionId, resolution: 'issue-first' })).rejects.toMatchObject({
    code: 'DEDUCTION_NO_TECHNICIAN',
  });
});

// ── FIX 7d — Terminal-guard prevents double-confirm: L1 + updateStatus null path ──

/**
 * FIX-7d tests the two layers that prevent double-processing:
 *
 *  L1 (serial): operator hits confirm twice — the second call arrives AFTER the first
 *  completes and sees suggestion.status === 'confirmed' → throws DeductionAlreadyConfirmedError.
 *
 *  L2 (updateStatus null): the in-memory terminal guard in updateStatus returns null when
 *  the suggestion has already reached a terminal state — the handler converts null → throw.
 *
 * Note: true concurrent race (same-microtask-tick double-confirm) is DB-level SERIALIZABLE
 * or SELECT-FOR-UPDATE territory and cannot be accurately simulated with a shared in-memory
 * store (both L2 checks run before either movement is stored). The serial-confirm path
 * covers the real-world operator mistake scenario.
 */
test('FIX-7d (serial): second confirm after first succeeds → L1 throws DeductionAlreadyConfirmedError', async () => {
  const { deductions, consumptions, stock, useCase, movements } = await buildSetup();

  const techLocationId = 'loc-tech-tech-1';
  const consumptionId = 'cons-double';
  const suggestionId = 'sug-double';
  const materialId = 'mat-double';

  await stock.upsert({ id: randomUUID(), materialCatalogId: materialId, locationId: techLocationId, qty: 10 });
  await seedConsumption(consumptions, consumptionId, 'task-double', materialId, 3);
  await seedSuggestion(deductions, {
    id: suggestionId,
    taskMaterialConsumptionId: consumptionId,
    technicianLocationId: techLocationId,
    materialCatalogId: materialId,
    qty: 3,
    status: 'pending',
  });

  // First confirm succeeds
  await expect(useCase.execute({ suggestionId, resolution: 'deduct' })).resolves.toMatchObject({
    status: 'confirmed',
    resolution: 'deduct',
  });

  // Exactly one CONSUME recorded
  const consumesAfterFirst = movements.movements.filter(m => m.type === 'CONSUME');
  expect(consumesAfterFirst).toHaveLength(1);

  // Second confirm hits L1 terminal guard → DeductionAlreadyConfirmedError
  await expect(useCase.execute({ suggestionId, resolution: 'deduct' })).rejects.toMatchObject({
    code: 'DEDUCTION_ALREADY_CONFIRMED',
  });

  // Still exactly one CONSUME (no double deduction)
  const consumesAfterSecond = movements.movements.filter(m => m.type === 'CONSUME');
  expect(consumesAfterSecond).toHaveLength(1);

  // Stock decremented only once
  const stockAfter = await stock.findByMaterialAndLocation(materialId, techLocationId);
  expect(stockAfter!.qty).toBe(7); // 10 - 3
});

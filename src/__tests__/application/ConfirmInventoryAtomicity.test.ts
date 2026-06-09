import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { ResolveClientLocation } from '@application/use-cases/ResolveClientLocation';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { InMemoryMaterialCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialCatalogRepository';
import { InMemoryTaskMaterialConsumptionRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskMaterialConsumptionRepository';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import { createStockLocation } from '@domain/entities/stock-location';
import {
  InventoryMovementRepository,
  MovementFilters,
  RecordMovementInput,
} from '@domain/ports/InventoryMovementRepository';
import { InventoryMovement } from '@domain/entities/inventory-movement';
import { randomUUID } from 'crypto';

const BASE_TYPES = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];

/**
 * Movement repo decorator that throws once on the next `record()` (Fix #1/#3
 * rollback). Exposes the inner `.movements` array so the in-memory UnitOfWork can
 * snapshot/rollback it — and so the dual-write that runs through the tx-scoped
 * bag (which is THIS repo) actually hits the injected failure.
 */
class FailingMovementRepo implements InventoryMovementRepository {
  failNext = false;
  constructor(private readonly inner: InMemoryInventoryMovementRepository) {}
  get movements(): InventoryMovement[] {
    return this.inner.movements;
  }
  async record(input: RecordMovementInput): Promise<InventoryMovement> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('INJECTED movement failure');
    }
    return this.inner.record(input);
  }
  async listByAsset(assetId: string): Promise<InventoryMovement[]> {
    return this.inner.listByAsset(assetId);
  }
  async findBySourceRef(sourceRef: string): Promise<InventoryMovement | null> {
    return this.inner.findBySourceRef(sourceRef);
  }
  async listMovements(filters: MovementFilters, page: number, limit: number): Promise<{ items: InventoryMovement[]; total: number }> {
    return this.inner.listMovements(filters, page, limit);
  }
}

async function setup() {
  const suggestions = new InMemoryInventorySuggestionRepository();
  const inventory = new InMemoryContractInventoryRepository();
  const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());
  const users = new InMemoryRbacUserRepository();
  const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
  for (const name of BASE_TYPES) await catalogRepo.create({ name, active: true, sortOrder: 0 });
  const materialRepo = new InMemoryMaterialCatalogRepository();
  await materialRepo.create({ name: 'OTRO', unit: 'unidad', active: true, sortOrder: 99 });
  const consumptionRepo = new InMemoryTaskMaterialConsumptionRepository();
  const locationRepo = new InMemoryStockLocationRepository();
  const assetRepo = new InMemoryInventoryAssetRepository();
  const materialStockRepo = new InMemoryMaterialStockRepository();
  const innerMovementRepo = new InMemoryInventoryMovementRepository(assetRepo, materialStockRepo);
  const movementRepo = new FailingMovementRepo(innerMovementRepo);
  const uow = new InMemoryUnitOfWork(
    suggestions, inventory, locationRepo, assetRepo, movementRepo, materialStockRepo,
  );
  const confirm = new ConfirmInventorySuggestion(
    suggestions, inventory, scheduling, users, catalogRepo, materialRepo, consumptionRepo,
    locationRepo, assetRepo, movementRepo, uow,
  );
  return {
    suggestions, inventory, scheduling, users, catalogRepo, confirm,
    locationRepo, assetRepo, innerMovementRepo, movementRepo, uow,
  };
}

const sug = (over: Partial<TaskInventorySuggestion>): TaskInventorySuggestion => ({
  id: 's1', taskId: 't1', kind: 'DEVICE', deviceType: 'ROUTER', qwenDeviceType: null, serialNumber: 'R1', mac: null,
  materialDesc: null, quantity: null, unit: null, source: 'OCR', photoUrl: null,
  status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z', ...over,
});

describe('Fix #1: confirm dual-write is atomic', () => {
  it('a failing INSTALL movement rolls back asset + CII; suggestion stays pending', async () => {
    const { suggestions, inventory, scheduling, confirm, assetRepo, innerMovementRepo, movementRepo } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'C1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'SN-FAIL' }));

    movementRepo.failNext = true;
    await expect(confirm.execute({ suggestionId: 's1' })).rejects.toThrow('INJECTED movement failure');

    // Nothing persisted: no asset, no CII, no movement, suggestion still pending.
    expect(assetRepo.store.size).toBe(0);
    expect(await inventory.listByContract('C1')).toHaveLength(0);
    expect(innerMovementRepo.movements).toHaveLength(0);
    const stored = await suggestions.get('s1');
    expect(stored!.status).toBe('pending');
    expect(stored!.confirmedItemId).toBeNull();
  });
});

describe('Fix #3: replace() is atomic', () => {
  it('a mid-replace failure rolls back: old item stays active, no new asset/CII', async () => {
    const { suggestions, inventory, scheduling, confirm, assetRepo, innerMovementRepo, movementRepo } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'C1' });
    // First confirm creates the original asset + CII (movement succeeds).
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'OLD' }));
    const first = await confirm.execute({ suggestionId: 's1' });
    if (first.kind !== 'DEVICE') throw new Error('expected DEVICE');
    const oldItemId = first.item.id;
    const oldAssetId = (await inventory.getById(oldItemId))!.assetId!;
    const assetsBefore = assetRepo.store.size;
    const movementsBefore = innerMovementRepo.movements.length;

    // replace with a new device, but the INSTALL movement for the new asset fails.
    await suggestions.upsert(sug({ id: 's2', deviceType: 'ROUTER', serialNumber: 'NEW' }));
    movementRepo.failNext = true;
    await expect(confirm.replace({ suggestionId: 's2' })).rejects.toThrow('INJECTED movement failure');

    // Old item still active (retire was rolled back); old asset still installed.
    const oldItem = await inventory.getById(oldItemId);
    expect(oldItem!.status).toBe('active');
    expect((await assetRepo.findById(oldAssetId))!.status).toBe('installed');
    // No new asset / CII / movement landed.
    expect(assetRepo.store.size).toBe(assetsBefore);
    expect(innerMovementRepo.movements.length).toBe(movementsBefore);
    expect(await assetRepo.findBySerialNumber('NEW')).toBeNull();
    const stored = await suggestions.get('s2');
    expect(stored!.status).toBe('pending');
  });
});

describe('Fix #2: cross-contract serial reuse is refused', () => {
  it('serial installed on contract A → confirming on B throws ASSET_INSTALLED_ELSEWHERE, no relocation', async () => {
    const { suggestions, inventory, scheduling, confirm, assetRepo, locationRepo } = await setup();
    // Contract A confirm installs SN-X at A's CLIENTE location.
    scheduling.seedTask({ id: 'tA', contractId: 'A' });
    await suggestions.upsert(sug({ id: 'sA', taskId: 'tA', deviceType: 'ROUTER', serialNumber: 'SN-X' }));
    const a = await confirm.execute({ suggestionId: 'sA' });
    if (a.kind !== 'DEVICE') throw new Error('expected DEVICE');
    const assetId = (await inventory.getById(a.item.id))!.assetId!;
    const locA = (await locationRepo.findByTypeAndContract('CLIENTE', 'A'))!;

    // Contract B tries to confirm the SAME serial → refused.
    scheduling.seedTask({ id: 'tB', contractId: 'B' });
    await suggestions.upsert(sug({ id: 'sB', taskId: 'tB', deviceType: 'ROUTER', serialNumber: 'SN-X' }));
    await expect(confirm.execute({ suggestionId: 'sB' })).rejects.toMatchObject({ code: 'ASSET_INSTALLED_ELSEWHERE' });

    // Asset NOT relocated — still at A.
    expect((await assetRepo.findById(assetId))!.currentLocationId).toBe(locA.id);
    expect(await inventory.listByContract('B')).toHaveLength(0);
  });

  it('an available asset with the same serial IS reused (no throw)', async () => {
    const { suggestions, scheduling, confirm, assetRepo, locationRepo, inventory } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'C1' });
    // Seed an available asset at a DEPOSITO-ish location + an existing CLIENTE for C1.
    const dep = await locationRepo.create(createStockLocation({ id: 'dep', type: 'DEPOSITO', code: 'DEPOSITO' }));
    await assetRepo.create(createInventoryAsset({
      id: 'a-avail', serialNumber: 'SN-AVAIL', deviceTypeId: 'whatever',
      status: 'available', currentLocationId: dep.id, source: 'MANUAL',
    }));
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'SN-AVAIL' }));

    const r = await confirm.execute({ suggestionId: 's1' });
    if (r.kind !== 'DEVICE') throw new Error('expected DEVICE');
    const cii = await inventory.getById(r.item.id);
    // Reused the existing available asset (same id), not a duplicate.
    expect(cii!.assetId).toBe('a-avail');
    expect(assetRepo.store.size).toBe(1);
  });
});

describe('Fix #5: unresolvable deviceType is refused, never written as FK', () => {
  it('throws UNRESOLVABLE_DEVICE_TYPE when neither the type name nor OTROS resolves', async () => {
    const { suggestions, scheduling, confirm, catalogRepo, assetRepo, inventory } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'C1' });
    // Unknown deviceType → route-level toType() maps it to 'OTROS'. Remove OTROS
    // from the catalog so BOTH the name lookup and the OTROS fallback fail →
    // dualWriteAsset must refuse rather than write 'OTROS' as the FK id.
    const otros = await catalogRepo.getByName('OTROS');
    await catalogRepo.delete(otros!.id);
    await suggestions.upsert(sug({ id: 's1', deviceType: 'SUBMARINO', serialNumber: 'SN-1' }));

    await expect(confirm.execute({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'UNRESOLVABLE_DEVICE_TYPE' });
    // Atomic: the rejected confirm left nothing behind.
    expect(assetRepo.store.size).toBe(0);
    expect(await inventory.listByContract('C1')).toHaveLength(0);
  });
});

describe('Fix #4: ResolveClientLocation survives the P2002 create race', () => {
  it('on a unique-violation create, re-finds and returns the competitor row', async () => {
    const locations = new InMemoryStockLocationRepository();
    // Simulate the race: first find misses; create throws a P2002-shaped error
    // AFTER a competitor inserted the row, so the retry find succeeds.
    let created = false;
    const racing = {
      findByTypeAndContract: async (type: string, contractId: string) => {
        return locations.findByTypeAndContract(type, contractId);
      },
      findByCode: locations.findByCode.bind(locations),
      findByTypeAndTechnician: locations.findByTypeAndTechnician.bind(locations),
      create: async (loc: ReturnType<typeof createStockLocation>) => {
        if (!created) {
          created = true;
          // competitor wins: insert directly, then this create "fails" with P2002.
          await locations.create(createStockLocation({ id: 'winner', type: 'CLIENTE', contractId: 'C1' }));
          const e: Error & { code?: string } = new Error('Unique constraint failed');
          e.code = 'P2002';
          throw e;
        }
        return locations.create(loc);
      },
    };
    const resolve = new ResolveClientLocation(racing as never);
    const result = await resolve.execute('C1');
    expect(result.id).toBe('winner');
  });
});

describe('Fix #7: composed wiring pins the dual-write', () => {
  it('confirm with full prod-shaped wiring creates an InventoryAsset + INSTALL movement', async () => {
    // Mirrors app.ts: all dual-write deps + a UnitOfWork present.
    const { suggestions, scheduling, confirm, assetRepo, innerMovementRepo, inventory } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'C1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'SN-WIRE' }));

    const r = await confirm.execute({ suggestionId: 's1' });
    if (r.kind !== 'DEVICE') throw new Error('expected DEVICE');

    const asset = await assetRepo.findBySerialNumber('SN-WIRE');
    expect(asset).not.toBeNull();
    expect(asset!.status).toBe('installed');
    const movements = await innerMovementRepo.listByAsset(asset!.id);
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe('INSTALL');
    expect((await inventory.getById(r.item.id))!.assetId).toBe(asset!.id);
  });
});

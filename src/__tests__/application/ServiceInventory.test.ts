import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { CreateManualSuggestion } from '@application/use-cases/CreateManualSuggestion';
import { DiscardInventorySuggestion } from '@application/use-cases/DiscardInventorySuggestion';
import { ListContractInstalledItems } from '@application/use-cases/ListContractInstalledItems';
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
import { ListClientEquipment } from '@application/use-cases/ListClientEquipment';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';

const BASE_TYPES = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];

async function seedDeviceCatalog(repo: InMemoryDeviceTypeCatalogRepository) {
  for (const name of BASE_TYPES) {
    await repo.create({ name, active: true, sortOrder: 0 });
  }
}

async function seedMaterialCatalog(repo: InMemoryMaterialCatalogRepository) {
  await repo.create({ name: 'CABLE_UTP', unit: 'm', active: true, sortOrder: 0 });
  await repo.create({ name: 'CONECTOR_RJ45', unit: 'unidad', active: true, sortOrder: 1 });
  await repo.create({ name: 'OTRO', unit: 'unidad', active: true, sortOrder: 99 });
}

async function setup() {
  const suggestions = new InMemoryInventorySuggestionRepository();
  const inventory = new InMemoryContractInventoryRepository();
  const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());
  const users = new InMemoryRbacUserRepository();
  const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
  await seedDeviceCatalog(catalogRepo);
  const materialRepo = new InMemoryMaterialCatalogRepository();
  await seedMaterialCatalog(materialRepo);
  const consumptionRepo = new InMemoryTaskMaterialConsumptionRepository();
  // Inventory Foundation (W1) dual-write deps
  const locationRepo = new InMemoryStockLocationRepository();
  const assetRepo = new InMemoryInventoryAssetRepository();
  const materialStockRepo = new InMemoryMaterialStockRepository();
  const movementRepo = new InMemoryInventoryMovementRepository(assetRepo, materialStockRepo);
  const uow = new InMemoryUnitOfWork(
    suggestions, inventory, locationRepo, assetRepo, movementRepo, materialStockRepo,
  );
  const confirm = new ConfirmInventorySuggestion(
    suggestions, inventory, scheduling, users, catalogRepo, materialRepo, consumptionRepo,
    locationRepo, assetRepo, movementRepo, uow,
  );
  const listItems = new ListContractInstalledItems(inventory, users);
  const discard = new DiscardInventorySuggestion(suggestions);
  return {
    suggestions, inventory, scheduling, users, confirm, listItems, discard,
    materialRepo, consumptionRepo, locationRepo, assetRepo, movementRepo, materialStockRepo, uow,
  };
}

const sug = (over: Partial<TaskInventorySuggestion>): TaskInventorySuggestion => ({
  id: 's1', taskId: 't1', kind: 'DEVICE', deviceType: 'ROUTER', qwenDeviceType: null, serialNumber: 'R1', mac: null,
  materialDesc: null, quantity: null, unit: null, source: 'OCR', photoUrl: null,
  status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z', ...over,
});

describe('ConfirmInventorySuggestion', () => {
  it('SCEN-CF-1: confirms a DEVICE suggestion → one ContractInstalledItem on the contract', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'R1', mac: 'MR' }));

    const result = await confirm.execute({ suggestionId: 's1', addedByUserId: 'u9' });

    expect(result.kind).toBe('DEVICE');
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    expect(result.item.contractId).toBe('svc1');
    expect(result.item.type).toBe('ROUTER');
    expect(result.item.serialNumber).toBe('R1');
    expect(result.item.mac).toBe('MR');
    expect(result.item.addedByUserId).toBe('u9');
    const stored = await suggestions.get('s1');
    expect(stored!.status).toBe('confirmed');
    expect(stored!.confirmedItemId).toBe(result.item.id);
    expect(await inventory.listByContract('svc1')).toHaveLength(1);
  });

  it('SCEN-CF-2: two routers confirmed → two rows (one per physical device)', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', serialNumber: 'R1' }));
    await suggestions.upsert(sug({ id: 's2', serialNumber: 'R2' }));

    await confirm.execute({ suggestionId: 's1' });
    await confirm.execute({ suggestionId: 's2' });

    const items = await inventory.listByContract('svc1');
    expect(items).toHaveLength(2);
    expect(items.map(i => i.serialNumber).sort()).toEqual(['R1', 'R2']);
  });

  it('SCEN-CF-3: task without contract → TASK_HAS_NO_CONTRACT', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: null });
    await suggestions.upsert(sug({ id: 's1' }));

    await expect(confirm.execute({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'TASK_HAS_NO_CONTRACT' });
  });

  it('SCEN-CF-4: confirming an already-confirmed suggestion → SUGGESTION_ALREADY_CONFIRMED', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1' }));
    await confirm.execute({ suggestionId: 's1' });

    await expect(confirm.execute({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'SUGGESTION_ALREADY_CONFIRMED' });
  });

  it('unknown suggestion → SUGGESTION_NOT_FOUND', async () => {
    const { confirm } = await setup();
    await expect(confirm.execute({ suggestionId: 'nope' })).rejects.toMatchObject({ code: 'SUGGESTION_NOT_FOUND' });
  });

  it('D.7: override desconocido → OTROS (no throw)', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ONU' }));

    const result = await confirm.execute({ suggestionId: 's1', typeOverride: 'SUBMARINO' });
    expect(result.kind).toBe('DEVICE');
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    expect(result.item.type).toBe('OTROS');
  });
});

describe('ConfirmInventorySuggestion — MATERIAL branch', () => {
  it('SCEN-MAT-1: kind=MATERIAL resolves existing material by UPPERCASE name and creates consumption', async () => {
    const { suggestions, scheduling, confirm, consumptionRepo } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', deviceType: null, serialNumber: null,
      materialDesc: 'cable_utp', quantity: 10, unit: 'm',
    }));

    const result = await confirm.execute({ suggestionId: 's1', addedByUserId: 'u1' });

    expect(result.kind).toBe('MATERIAL');
    if (result.kind !== 'MATERIAL') throw new Error('expected MATERIAL');
    expect(result.consumption.materialName).toBe('cable_utp'); // snapshot: original IClass text
    expect(result.consumption.quantity).toBe(10);
    expect(result.consumption.unit).toBe('m');
    expect(result.consumption.taskId).toBe('t1');
    const consumptions = await consumptionRepo.listByTask('t1');
    expect(consumptions).toHaveLength(1);
    // material was matched by name, not newly created
    const stored = await suggestions.get('s1');
    expect(stored!.status).toBe('confirmed');
    expect(stored!.confirmedItemId).toBe(result.consumption.id);
  });

  it('SCEN-MAT-2: kind=MATERIAL with unknown materialDesc → create-if-missing', async () => {
    const { suggestions, scheduling, confirm, materialRepo } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', deviceType: null, serialNumber: null,
      materialDesc: 'nuevo_material', quantity: 3, unit: 'unidad',
    }));

    const result = await confirm.execute({ suggestionId: 's1' });

    expect(result.kind).toBe('MATERIAL');
    if (result.kind !== 'MATERIAL') throw new Error('expected MATERIAL');
    // new material was auto-created with UPPERCASE canonical name
    const created = await materialRepo.getByName('NUEVO_MATERIAL');
    expect(created).not.toBeNull();
    expect(result.consumption.materialCatalogId).toBe(created!.id);
  });

  it('SCEN-MAT-3: kind=MATERIAL with empty materialDesc → rejected (#18; was: fallback to OTRO)', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', deviceType: null, serialNumber: null,
      materialDesc: null, quantity: 1, unit: null,
    }));

    // #18: confirming a MATERIAL with no description is now rejected (no more silent OTRO fallback).
    await expect(confirm.execute({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'SUGGESTION_INCOMPLETE' });
  });

  it('SCEN-MAT-4: MATERIAL with task without contract → TASK_HAS_NO_CONTRACT', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: null });
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', deviceType: null,
      materialDesc: 'cable_utp', quantity: 5, unit: 'm',
    }));

    await expect(confirm.execute({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'TASK_HAS_NO_CONTRACT' });
  });

  it('SCEN-MAT-5: MATERIAL preserves quantity=1 default when suggestion.quantity is null', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', deviceType: null,
      materialDesc: 'CABLE_UTP', quantity: null, unit: null,
    }));

    const result = await confirm.execute({ suggestionId: 's1' });
    if (result.kind !== 'MATERIAL') throw new Error('expected MATERIAL');
    expect(result.consumption.quantity).toBe(1);
  });

  it('SCEN-MAT-6: MATERIAL unit falls back to material.unit when suggestion.unit is null', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', deviceType: null,
      materialDesc: 'CABLE_UTP', quantity: 5, unit: null, // no unit on suggestion
    }));

    const result = await confirm.execute({ suggestionId: 's1' });
    if (result.kind !== 'MATERIAL') throw new Error('expected MATERIAL');
    expect(result.consumption.unit).toBe('m'); // from material.unit
  });
});

describe('Trazabilidad del aprobador (F4)', () => {
  it('confirm DEVICE resolves addedByUserName desde el RbacUserRepository', async () => {
    const { suggestions, scheduling, users, confirm } = await setup();
    const u = await users.create({ name: 'María López', email: 'm@x.com', login: 'maria', passwordHash: 'h' });
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1' }));

    const result = await confirm.execute({ suggestionId: 's1', addedByUserId: u.id });

    expect(result.kind).toBe('DEVICE');
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    expect(result.item.addedByUserId).toBe(u.id);
    expect(result.item.addedByUserName).toBe('María López');
  });

  it('addedByUserName es null cuando no hay addedByUserId', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1' }));

    const result = await confirm.execute({ suggestionId: 's1' });
    expect(result.kind).toBe('DEVICE');
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    expect(result.item.addedByUserName).toBeNull();
  });

  it('F5: aplica el typeOverride del operador en lugar del deviceType de la sugerencia', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ONU' }));

    const result = await confirm.execute({ suggestionId: 's1', typeOverride: 'ROUTER' });
    expect(result.kind).toBe('DEVICE');
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    expect(result.item.type).toBe('ROUTER');
  });

  it('#4: al confirmar con typeOverride, la sugerencia guardada refleja el tipo elegido (ANTENA, no el ONU original)', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ONU' }));

    await confirm.execute({ suggestionId: 's1', typeOverride: 'ANTENA' });

    const stored = await suggestions.get('s1');
    expect(stored!.status).toBe('confirmed');
    expect(stored!.deviceType).toBe('ANTENA');
  });

  it('#4: sin typeOverride, la sugerencia conserva su deviceType original', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER' }));

    await confirm.execute({ suggestionId: 's1' });

    const stored = await suggestions.get('s1');
    expect(stored!.deviceType).toBe('ROUTER');
  });

  it('ListContractInstalledItems resuelve el nombre del aprobador por item', async () => {
    const { suggestions, scheduling, users, confirm, listItems } = await setup();
    const u = await users.create({ name: 'Carlos Sánchez', email: 'c@x.com', login: 'carlos', passwordHash: 'h' });
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1' }));
    await confirm.execute({ suggestionId: 's1', addedByUserId: u.id });

    const items = await listItems.execute('svc1');
    expect(items).toHaveLength(1);
    expect(items[0].addedByUserName).toBe('Carlos Sánchez');
  });
});

describe('ConfirmInventorySuggestion — min-data guard (#18)', () => {
  it('DEVICE without SN nor MAC → rejects SUGGESTION_INCOMPLETE and creates no item', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', kind: 'DEVICE', serialNumber: null, mac: null }));

    await expect(confirm.execute({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'SUGGESTION_INCOMPLETE' });
    expect(await inventory.listByContract('svc1')).toHaveLength(0);
  });

  it('DEVICE with only MAC → confirms OK', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', kind: 'DEVICE', serialNumber: null, mac: 'AABBCCDDEEFF' }));

    const result = await confirm.execute({ suggestionId: 's1' });
    expect(result.kind).toBe('DEVICE');
  });

  it('replace() DEVICE without SN nor MAC → rejects SUGGESTION_INCOMPLETE', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', kind: 'DEVICE', serialNumber: null, mac: null }));

    await expect(confirm.replace({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'SUGGESTION_INCOMPLETE' });
  });
});

describe('ConfirmInventorySuggestion — resolution matrix', () => {
  const makeActiveItem = (over: Partial<import('@domain/entities/contract-installed-item').ContractInstalledItem> = {}) => ({
    id: 'i_existing', contractId: 'svc1', type: 'ROUTER', serialNumber: 'R1', mac: null, model: null,
    source: 'MANUAL', sourceTaskId: null, addedByUserId: null, confirmedAt: null,
    status: 'active' as const, notes: null, replacesItemId: null, assetId: null, createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
    ...over,
  });

  // Case A: same_device + add → DUPLICATE_INSTALLED_ITEM
  it('A: same_device + add → throws DUPLICATE_INSTALLED_ITEM; inventory unchanged', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeActiveItem({ id: 'i1', serialNumber: 'R1' }));
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'R1' }));

    await expect(confirm.execute({ suggestionId: 's1', resolution: 'add' })).rejects.toMatchObject({ code: 'DUPLICATE_INSTALLED_ITEM' });
    expect(await inventory.listByContract('svc1')).toHaveLength(1);
  });

  // Case B: same_device by MAC + no resolution (default add) → DUPLICATE_INSTALLED_ITEM
  it('B: same_device by MAC + default resolution → throws DUPLICATE_INSTALLED_ITEM', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeActiveItem({ id: 'i1', mac: 'AABBCC', serialNumber: null }));
    await suggestions.upsert(sug({ id: 's1', mac: 'AA:BB:CC', serialNumber: null }));

    await expect(confirm.execute({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'DUPLICATE_INSTALLED_ITEM' });
  });

  // Case C: same_device + link_existing → setStatus(confirmed, existing.id), no create
  it('C: same_device + link_existing → suggestion confirmed to existing item, no new item created', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeActiveItem({ id: 'i_existing', serialNumber: 'R1' }));
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'R1' }));

    const result = await confirm.execute({ suggestionId: 's1', resolution: 'link_existing' });

    expect(result.kind).toBe('DEVICE');
    // No new item created — still exactly 1 item
    expect(await inventory.listByContract('svc1')).toHaveLength(1);
    // Suggestion now confirmed to the existing item
    const stored = await suggestions.get('s1');
    expect(stored!.status).toBe('confirmed');
    expect(stored!.confirmedItemId).toBe('i_existing');
    // Result DTO reflects the existing item
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    expect(result.item.id).toBe('i_existing');
  });

  // Case D: same_type + add → creates 2nd item; both active; replacesItemId=null
  it('D: same_type + add → creates 2nd item; both active; replacesItemId=null', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeActiveItem({ id: 'i1', serialNumber: 'R1', type: 'ROUTER' }));
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'R2' }));

    const result = await confirm.execute({ suggestionId: 's1', resolution: 'add' });

    expect(result.kind).toBe('DEVICE');
    const items = await inventory.listByContract('svc1');
    expect(items).toHaveLength(2);
    expect(items.every(i => i.status === 'active')).toBe(true);
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    expect(result.item.replacesItemId).toBeNull();
  });

  // Case E: same_type + replace() → old=replaced; new active with replacesItemId=old.id
  it('E: replace() same_type → old replaced; new active with replacesItemId', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeActiveItem({ id: 'i_old', serialNumber: 'R1', type: 'ROUTER' }));
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'R2' }));

    const result = await confirm.replace({ suggestionId: 's1' });

    expect(result.kind).toBe('DEVICE');
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    // New item links to the old one
    expect(result.item.replacesItemId).toBe('i_old');
    expect(result.item.status).toBe('active');
    // Old item is now replaced
    const oldItem = await inventory.getById('i_old');
    expect(oldItem!.status).toBe('replaced');
    // Suggestion confirmed to new item
    const stored = await suggestions.get('s1');
    expect(stored!.status).toBe('confirmed');
    expect(stored!.confirmedItemId).toBe(result.item.id);
  });

  // Case F: no match + add (retrocompat: existing tests pass)
  it('F: no match + no resolution → creates item (retrocompat)', async () => {
    const { suggestions, scheduling, confirm, inventory } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'R1' }));

    const result = await confirm.execute({ suggestionId: 's1' });
    expect(result.kind).toBe('DEVICE');
    expect(await inventory.listByContract('svc1')).toHaveLength(1);
  });

  // Case G: replace() with empty inventory → NO_REPLACE_TARGET
  it('G: replace() with no active items → NO_REPLACE_TARGET', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'R1' }));

    await expect(confirm.replace({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'NO_REPLACE_TARGET' });
  });

  // Case H: replace() with only replaced-status item → NO_REPLACE_TARGET
  it('H: replace() when only replaced-status items exist → NO_REPLACE_TARGET', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeActiveItem({ id: 'i1', type: 'ROUTER', status: 'replaced' }));
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'R_NEW' }));

    await expect(confirm.replace({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'NO_REPLACE_TARGET' });
  });

  // Case I: MATERIAL + execute → unchanged MATERIAL path
  it('I: MATERIAL suggestion + execute → MATERIAL path unchanged', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', deviceType: null, serialNumber: null,
      materialDesc: 'CABLE_UTP', quantity: 2, unit: 'm',
    }));

    const result = await confirm.execute({ suggestionId: 's1', resolution: 'add' });
    expect(result.kind).toBe('MATERIAL');
  });

  // Case J: replace() with typeOverride → new item type=typeOverride
  it('J: replace() with typeOverride → new item uses override type', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeActiveItem({ id: 'i_old', serialNumber: 'R1', type: 'ROUTER' }));
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'R2' }));

    const result = await confirm.replace({ suggestionId: 's1', typeOverride: 'ANTENA' });

    expect(result.kind).toBe('DEVICE');
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    expect(result.item.type).toBe('ANTENA');
    // Old item replaced
    const oldItem = await inventory.getById('i_old');
    expect(oldItem!.status).toBe('replaced');
  });
});

describe('ContractInstalledItem — replacesItemId field', () => {
  it('create item with replacesItemId persists and reads back', async () => {
    const { inventory } = await setup();
    const now = new Date().toISOString();
    const older = await inventory.create({
      id: 'i_old', contractId: 'svc1', type: 'ROUTER', serialNumber: 'OLD_SN', mac: null, model: null,
      source: 'MANUAL', sourceTaskId: null, addedByUserId: null, confirmedAt: null,
      status: 'active', notes: null, replacesItemId: null, assetId: null, createdAt: now, updatedAt: now,
    });
    const newer = await inventory.create({
      id: 'i_new', contractId: 'svc1', type: 'ROUTER', serialNumber: 'NEW_SN', mac: null, model: null,
      source: 'ICLASS', sourceTaskId: null, addedByUserId: null, confirmedAt: null,
      status: 'active', notes: null, replacesItemId: older.id, assetId: null, createdAt: now, updatedAt: now,
    });
    const read = await inventory.getById('i_new');
    expect(read!.replacesItemId).toBe('i_old');
  });

  it('create item without replacesItemId → replacesItemId is null', async () => {
    const { inventory } = await setup();
    const now = new Date().toISOString();
    const item = await inventory.create({
      id: 'i1', contractId: 'svc1', type: 'ROUTER', serialNumber: 'R1', mac: null, model: null,
      source: 'MANUAL', sourceTaskId: null, addedByUserId: null, confirmedAt: null,
      status: 'active', notes: null, replacesItemId: null, assetId: null, createdAt: now, updatedAt: now,
    });
    expect(item.replacesItemId).toBeNull();
    const read = await inventory.getById('i1');
    expect(read!.replacesItemId).toBeNull();
  });
});

describe('ConfirmInventorySuggestion — dual-write (W1 HIGH-CARE)', () => {
  it('SIM-asset-created: confirm DEVICE → asset(installed,CLIENTE) + INSTALL movement + CII.assetId', async () => {
    const { suggestions, inventory, scheduling, confirm, assetRepo, movementRepo, locationRepo } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'C1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'SN123' }));

    const result = await confirm.execute({ suggestionId: 's1', addedByUserId: 'u1' });
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');

    // CII created with a non-null assetId
    const cii = await inventory.getById(result.item.id);
    expect(cii!.assetId).not.toBeNull();

    // Asset created: installed, at the contract's CLIENTE location
    const asset = await assetRepo.findBySerialNumber('SN123');
    expect(asset).not.toBeNull();
    expect(asset!.status).toBe('installed');
    const clienteLoc = await locationRepo.findByTypeAndContract('CLIENTE', 'C1');
    expect(clienteLoc).not.toBeNull();
    expect(asset!.currentLocationId).toBe(clienteLoc!.id);
    expect(cii!.assetId).toBe(asset!.id);

    // Exactly one INSTALL movement referencing the asset + task
    const movements = await movementRepo.listByAsset(asset!.id);
    expect(movements).toHaveLength(1);
    expect(movements[0].type).toBe('INSTALL');
    expect(movements[0].taskId).toBe('t1');
  });

  it('SIM-cii-queryable: CII still queryable after confirm (operator UX unchanged)', async () => {
    const { suggestions, scheduling, confirm, listItems } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'C1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'SN123' }));

    await confirm.execute({ suggestionId: 's1' });

    const items = await listItems.execute('C1');
    expect(items).toHaveLength(1);
    expect(items[0].serialNumber).toBe('SN123');
    expect(items[0].type).toBe('ROUTER');
    expect(items[0].status).toBe('active');
  });

  it('SIM-material-no-asset: confirm MATERIAL → no asset, no movement', async () => {
    const { suggestions, scheduling, confirm, assetRepo, movementRepo } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'C1' });
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', deviceType: null, serialNumber: null,
      materialDesc: 'CABLE_UTP', quantity: 5, unit: 'm',
    }));

    const result = await confirm.execute({ suggestionId: 's1' });
    expect(result.kind).toBe('MATERIAL');
    expect(assetRepo.store.size).toBe(0);
    expect(movementRepo.movements).toHaveLength(0);
  });

  it('replace() DEVICE → retired asset marked removed, new asset installed', async () => {
    const { suggestions, inventory, scheduling, confirm, assetRepo } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'C1' });
    // First confirm creates the original asset+CII
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'OLD' }));
    const first = await confirm.execute({ suggestionId: 's1' });
    if (first.kind !== 'DEVICE') throw new Error('expected DEVICE');
    const oldAssetId = (await inventory.getById(first.item.id))!.assetId!;

    // replace with a new device → old asset removed, new installed, CII linked
    await suggestions.upsert(sug({ id: 's2', deviceType: 'ROUTER', serialNumber: 'NEW' }));
    const result = await confirm.replace({ suggestionId: 's2' });
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');

    const oldAsset = await assetRepo.findById(oldAssetId);
    expect(oldAsset!.status).toBe('removed');
    const newAsset = await assetRepo.findBySerialNumber('NEW');
    expect(newAsset!.status).toBe('installed');
    const newCii = await inventory.getById(result.item.id);
    expect(newCii!.assetId).toBe(newAsset!.id);
  });

  it('TaskHasNoContractError unchanged under dual-write', async () => {
    const { suggestions, scheduling, confirm, assetRepo } = await setup();
    scheduling.seedTask({ id: 't1', contractId: null });
    await suggestions.upsert(sug({ id: 's1', serialNumber: 'SN1' }));

    await expect(confirm.execute({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'TASK_HAS_NO_CONTRACT' });
    expect(assetRepo.store.size).toBe(0);
  });
});

describe('DiscardInventorySuggestion', () => {
  it('marks the suggestion discarded', async () => {
    const { suggestions, discard } = await setup();
    await suggestions.upsert(sug({ id: 's1' }));
    const out = await discard.execute('s1');
    expect(out.status).toBe('discarded');
  });

  it('unknown suggestion → SUGGESTION_NOT_FOUND', async () => {
    const { discard } = await setup();
    await expect(discard.execute('nope')).rejects.toMatchObject({ code: 'SUGGESTION_NOT_FOUND' });
  });
});

describe('CreateManualSuggestion (A4.1)', () => {
  async function setupManual() {
    const base = await setup();
    const catalogRepo = new InMemoryDeviceTypeCatalogRepository();
    await seedDeviceCatalog(catalogRepo);
    const deviceTypeCatalogService = new (await import('@application/services/DeviceTypeCatalogService')).DeviceTypeCatalogService(catalogRepo);
    const createManual = new CreateManualSuggestion(
      base.suggestions,
      base.scheduling,
      base.inventory,
      deviceTypeCatalogService,
    );
    return { ...base, createManual };
  }

  it('DEVICE solo SN → sugerencia MANUAL pending guardada', async () => {
    const { scheduling, createManual } = await setupManual();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });

    const dto = await createManual.execute({
      taskId: 't1', kind: 'DEVICE', type: 'ROUTER', serialNumber: 'SN-001', mac: null,
      materialDesc: null, quantity: null, unit: null,
    });

    expect(dto.source).toBe('MANUAL');
    expect(dto.status).toBe('pending');
    expect(dto.serialNumber).toBe('SN-001');
    expect(dto.kind).toBe('DEVICE');
  });

  it('DEVICE solo MAC → sugerencia MANUAL pending guardada', async () => {
    const { scheduling, createManual } = await setupManual();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });

    const dto = await createManual.execute({
      taskId: 't1', kind: 'DEVICE', type: 'ONU', serialNumber: null, mac: 'AA:BB:CC:DD:EE:FF',
      materialDesc: null, quantity: null, unit: null,
    });

    expect(dto.source).toBe('MANUAL');
    expect(dto.status).toBe('pending');
    expect(dto.mac).toBe('AA:BB:CC:DD:EE:FF');
  });

  it('MATERIAL happy path → sugerencia MANUAL pending guardada', async () => {
    const { scheduling, createManual } = await setupManual();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });

    const dto = await createManual.execute({
      taskId: 't1', kind: 'MATERIAL', type: undefined, serialNumber: null, mac: null,
      materialDesc: 'Cable coaxial 10m', quantity: 2, unit: 'm',
    });

    expect(dto.source).toBe('MANUAL');
    expect(dto.status).toBe('pending');
    expect(dto.materialDesc).toBe('Cable coaxial 10m');
    expect(dto.kind).toBe('MATERIAL');
  });

  it('DEVICE sin SN ni MAC → lanza IncompleteSuggestionError (422 code)', async () => {
    const { scheduling, createManual } = await setupManual();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });

    await expect(createManual.execute({
      taskId: 't1', kind: 'DEVICE', type: 'ANTENA', serialNumber: null, mac: null,
      materialDesc: null, quantity: null, unit: null,
    })).rejects.toMatchObject({ code: 'SUGGESTION_INCOMPLETE' });
  });

  it('tipo desconocido → lanza InvalidItemTypeError (422)', async () => {
    const { scheduling, createManual } = await setupManual();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });

    await expect(createManual.execute({
      taskId: 't1', kind: 'DEVICE', type: 'SUBMARINO', serialNumber: 'SN-X', mac: null,
      materialDesc: null, quantity: null, unit: null,
    })).rejects.toMatchObject({ code: 'INVALID_ITEM_TYPE' });
  });

  it('task no encontrada → lanza TaskNotFoundError (404)', async () => {
    const { createManual } = await setupManual();

    await expect(createManual.execute({
      taskId: 'no-existe', kind: 'DEVICE', type: 'ROUTER', serialNumber: 'SN-X', mac: null,
      materialDesc: null, quantity: null, unit: null,
    })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });
});

describe('ConfirmInventorySuggestion — source pass-through (A3.1)', () => {
  it('SCEN-CF-5: sugerencia MANUAL confirmada → ContractInstalledItem.source = MANUAL', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', source: 'MANUAL', serialNumber: 'SN-M' }));

    const result = await confirm.execute({ suggestionId: 's1' });

    expect(result.kind).toBe('DEVICE');
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    const item = await inventory.getById(result.item.id);
    expect(item!.source).toBe('MANUAL');
  });

  it('SCEN-CF-6: sugerencia OCR confirmada → ContractInstalledItem.source = OCR', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', source: 'OCR', serialNumber: 'SN-O' }));

    const result = await confirm.execute({ suggestionId: 's1' });

    expect(result.kind).toBe('DEVICE');
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    const item = await inventory.getById(result.item.id);
    expect(item!.source).toBe('OCR');
  });

  it('SCEN-CF-7: sugerencia ICLASS_MATERIAL confirmada → ContractInstalledItem.source = ICLASS', async () => {
    const { suggestions, inventory, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', source: 'ICLASS_MATERIAL', serialNumber: 'SN-I' }));

    const result = await confirm.execute({ suggestionId: 's1' });

    expect(result.kind).toBe('DEVICE');
    if (result.kind !== 'DEVICE') throw new Error('expected DEVICE');
    const item = await inventory.getById(result.item.id);
    expect(item!.source).toBe('ICLASS');
  });
});

describe('InventorySuggestionRepository.create() — aislamiento MANUAL/OCR (A2.1)', () => {
  it('create(MANUAL, SN-1) no clobber upsert OCR: ambas filas coexisten y el OCR conserva photoUrl', async () => {
    const { suggestions } = await setup();

    // Seed OCR via upsert
    const ocrSug: TaskInventorySuggestion = {
      id: 'ocr-1', taskId: 'T1', kind: 'DEVICE', deviceType: 'ONU', qwenDeviceType: 'ONU',
      serialNumber: 'SN-1', mac: null, materialDesc: null, quantity: null, unit: null,
      source: 'OCR', photoUrl: 'http://photo.jpg',
      status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z',
    };
    await suggestions.upsert(ocrSug);

    // create() MANUAL con mismo SN
    const manualSug: TaskInventorySuggestion = {
      id: 'manual-1', taskId: 'T1', kind: 'DEVICE', deviceType: 'ONU', qwenDeviceType: null,
      serialNumber: 'SN-1', mac: null, materialDesc: null, quantity: null, unit: null,
      source: 'MANUAL', photoUrl: null,
      status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z',
    };
    await suggestions.create(manualSug);

    const all = await suggestions.listByTask('T1');
    expect(all).toHaveLength(2);

    const ocr = all.find(s => s.id === 'ocr-1');
    expect(ocr).toBeDefined();
    expect(ocr!.photoUrl).toBe('http://photo.jpg');   // no fue tocado
    expect(ocr!.source).toBe('OCR');

    const manual = all.find(s => s.id === 'manual-1');
    expect(manual).toBeDefined();
    expect(manual!.source).toBe('MANUAL');
  });

  it('create(MANUAL) agrega segunda fila para la misma clave natural (duplicados permitidos en staging)', async () => {
    const { suggestions } = await setup();

    const base: TaskInventorySuggestion = {
      id: 'm1', taskId: 'T2', kind: 'DEVICE', deviceType: 'ROUTER', qwenDeviceType: null,
      serialNumber: 'SN-DUP', mac: null, materialDesc: null, quantity: null, unit: null,
      source: 'MANUAL', photoUrl: null,
      status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z',
    };
    await suggestions.create(base);
    await suggestions.create({ ...base, id: 'm2' });

    const all = await suggestions.listByTask('T2');
    expect(all).toHaveLength(2);
    expect(all.map(s => s.id).sort()).toEqual(['m1', 'm2']);
  });
});

describe('ListClientEquipment', () => {
  const item = (over: Partial<ContractInstalledItem> = {}): ContractInstalledItem => ({
    id: 'i1', contractId: 'c1', type: 'ROUTER', serialNumber: 'R1', mac: null, model: null,
    source: 'MANUAL', sourceTaskId: null, addedByUserId: null, confirmedAt: null,
    status: 'active', notes: null, replacesItemId: null, assetId: null,
    createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', ...over,
  });

  it('aggregates installed items across ALL of a client\'s contracts, grouped/sorted by contractId, decorated with contract context', async () => {
    const { inventory } = await setup();
    // Client CL1 has two contracts; CL2 has one (must be excluded).
    inventory.seedContract('c1', { clientId: 'CL1', plan: 'Fibra 300', type: 'internet' });
    inventory.seedContract('c2', { clientId: 'CL1', plan: 'TV Pack', type: 'tv' });
    inventory.seedContract('c9', { clientId: 'CL2', plan: 'Otro', type: 'internet' });
    await inventory.create(item({ id: 'i_c2', contractId: 'c2', createdAt: '2026-06-02T00:00:00Z' }));
    await inventory.create(item({ id: 'i_c1a', contractId: 'c1', createdAt: '2026-06-01T00:00:00Z', status: 'removed' }));
    await inventory.create(item({ id: 'i_c1b', contractId: 'c1', createdAt: '2026-06-03T00:00:00Z' }));
    await inventory.create(item({ id: 'i_other', contractId: 'c9' })); // CL2 — must NOT appear

    const dtos = await new ListClientEquipment(inventory).execute('CL1');

    // Both contracts of CL1, none of CL2
    expect(dtos.map(d => d.id)).toEqual(['i_c1a', 'i_c1b', 'i_c2']);
    // Contract context decorated
    expect(dtos[0]).toMatchObject({ contractId: 'c1', contractPlan: 'Fibra 300', contractType: 'internet' });
    expect(dtos[2]).toMatchObject({ contractId: 'c2', contractPlan: 'TV Pack', contractType: 'tv' });
    // ALL statuses shown (active + removed)
    expect(dtos.find(d => d.id === 'i_c1a')!.status).toBe('removed');
  });

  it('returns [] for a client with no contracts/items', async () => {
    const { inventory } = await setup();
    const dtos = await new ListClientEquipment(inventory).execute('NOBODY');
    expect(dtos).toEqual([]);
  });
});

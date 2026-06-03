import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { AddInstalledItemManually } from '@application/use-cases/AddInstalledItemManually';
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
  const confirm = new ConfirmInventorySuggestion(
    suggestions, inventory, scheduling, users, catalogRepo, materialRepo, consumptionRepo,
  );
  const listItems = new ListContractInstalledItems(inventory, users);
  const addManual = new AddInstalledItemManually(inventory);
  const discard = new DiscardInventorySuggestion(suggestions);
  return { suggestions, inventory, scheduling, users, confirm, listItems, addManual, discard, materialRepo, consumptionRepo };
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

  it('SCEN-MAT-3: kind=MATERIAL with empty materialDesc → fallback to OTRO', async () => {
    const { suggestions, scheduling, confirm } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', deviceType: null, serialNumber: null,
      materialDesc: null, quantity: 1, unit: null,
    }));

    const result = await confirm.execute({ suggestionId: 's1' });

    expect(result.kind).toBe('MATERIAL');
    if (result.kind !== 'MATERIAL') throw new Error('expected MATERIAL');
    // fallback material is OTRO
    expect(result.consumption.materialName).toBe('OTRO');
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

describe('AddInstalledItemManually', () => {
  it('SCEN-MI-1: a manual 2nd router coexists with confirmed items', async () => {
    const { inventory, scheduling, confirm, suggestions, addManual } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', serialNumber: 'R1' }));
    await confirm.execute({ suggestionId: 's1' });

    const manual = await addManual.execute({ contractId: 'svc1', type: 'ROUTER', serialNumber: 'R2', addedByUserId: 'u9' });

    expect(manual.source).toBe('MANUAL');
    expect(manual.sourceTaskId).toBeNull();
    const items = await inventory.listByContract('svc1');
    expect(items).toHaveLength(2);
    expect(items.map(i => i.serialNumber).sort()).toEqual(['R1', 'R2']);
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

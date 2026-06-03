import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { AddInstalledItemManually } from '@application/use-cases/AddInstalledItemManually';
import { DiscardInventorySuggestion } from '@application/use-cases/DiscardInventorySuggestion';
import { ListContractInstalledItems } from '@application/use-cases/ListContractInstalledItems';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';

function setup() {
  const suggestions = new InMemoryInventorySuggestionRepository();
  const inventory = new InMemoryContractInventoryRepository();
  const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());
  const users = new InMemoryRbacUserRepository();
  const confirm = new ConfirmInventorySuggestion(suggestions, inventory, scheduling, users);
  const listItems = new ListContractInstalledItems(inventory, users);
  const addManual = new AddInstalledItemManually(inventory);
  const discard = new DiscardInventorySuggestion(suggestions);
  return { suggestions, inventory, scheduling, users, confirm, listItems, addManual, discard };
}

const sug = (over: Partial<TaskInventorySuggestion>): TaskInventorySuggestion => ({
  id: 's1', taskId: 't1', kind: 'DEVICE', deviceType: 'ROUTER', qwenDeviceType: null, serialNumber: 'R1', mac: null,
  materialDesc: null, quantity: null, unit: null, source: 'OCR', photoUrl: null,
  status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z', ...over,
});

describe('ConfirmInventorySuggestion', () => {
  it('SCEN-CF-1: confirms a DEVICE suggestion → one ContractInstalledItem on the contract', async () => {
    const { suggestions, inventory, scheduling, confirm } = setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'R1', mac: 'MR' }));

    const item = await confirm.execute({ suggestionId: 's1', addedByUserId: 'u9' });

    expect(item.contractId).toBe('svc1');
    expect(item.type).toBe('ROUTER');
    expect(item.serialNumber).toBe('R1');
    expect(item.mac).toBe('MR');
    expect(item.addedByUserId).toBe('u9');
    const stored = await suggestions.get('s1');
    expect(stored!.status).toBe('confirmed');
    expect(stored!.confirmedItemId).toBe(item.id);
    expect(await inventory.listByContract('svc1')).toHaveLength(1);
  });

  it('SCEN-CF-2: two routers confirmed → two rows (one per physical device)', async () => {
    const { suggestions, inventory, scheduling, confirm } = setup();
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
    const { suggestions, scheduling, confirm } = setup();
    scheduling.seedTask({ id: 't1', contractId: null });
    await suggestions.upsert(sug({ id: 's1' }));

    await expect(confirm.execute({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'TASK_HAS_NO_CONTRACT' });
  });

  it('SCEN-CF-4: confirming an already-confirmed suggestion → SUGGESTION_ALREADY_CONFIRMED', async () => {
    const { suggestions, scheduling, confirm } = setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1' }));
    await confirm.execute({ suggestionId: 's1' });

    await expect(confirm.execute({ suggestionId: 's1' })).rejects.toMatchObject({ code: 'SUGGESTION_ALREADY_CONFIRMED' });
  });

  it('unknown suggestion → SUGGESTION_NOT_FOUND', async () => {
    const { confirm } = setup();
    await expect(confirm.execute({ suggestionId: 'nope' })).rejects.toMatchObject({ code: 'SUGGESTION_NOT_FOUND' });
  });
});

describe('Trazabilidad del aprobador (F4)', () => {
  it('confirm resuelve addedByUserName desde el RbacUserRepository', async () => {
    const { suggestions, scheduling, users, confirm } = setup();
    const u = await users.create({ name: 'María López', email: 'm@x.com', login: 'maria', passwordHash: 'h' });
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1' }));

    const item = await confirm.execute({ suggestionId: 's1', addedByUserId: u.id });

    expect(item.addedByUserId).toBe(u.id);
    expect(item.addedByUserName).toBe('María López');
  });

  it('addedByUserName es null cuando no hay addedByUserId', async () => {
    const { suggestions, scheduling, confirm } = setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1' }));

    const item = await confirm.execute({ suggestionId: 's1' });
    expect(item.addedByUserName).toBeNull();
  });

  it('F5: aplica el typeOverride del operador en lugar del deviceType de la sugerencia', async () => {
    const { suggestions, scheduling, confirm } = setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ONU' }));

    const item = await confirm.execute({ suggestionId: 's1', typeOverride: 'ROUTER' });
    expect(item.type).toBe('ROUTER');
  });

  it('#4: al confirmar con typeOverride, la sugerencia guardada refleja el tipo elegido (ANTENA, no el ONU original)', async () => {
    const { suggestions, scheduling, confirm } = setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ONU' }));

    await confirm.execute({ suggestionId: 's1', typeOverride: 'ANTENA' });

    const stored = await suggestions.get('s1');
    expect(stored!.status).toBe('confirmed');
    expect(stored!.deviceType).toBe('ANTENA');
  });

  it('#4: sin typeOverride, la sugerencia conserva su deviceType original', async () => {
    const { suggestions, scheduling, confirm } = setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER' }));

    await confirm.execute({ suggestionId: 's1' });

    const stored = await suggestions.get('s1');
    expect(stored!.deviceType).toBe('ROUTER');
  });

  it('ListContractInstalledItems resuelve el nombre del aprobador por item', async () => {
    const { suggestions, scheduling, users, confirm, listItems } = setup();
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
    const { inventory, scheduling, confirm, suggestions, addManual } = setup();
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
    const { suggestions, discard } = setup();
    await suggestions.upsert(sug({ id: 's1' }));
    const out = await discard.execute('s1');
    expect(out.status).toBe('discarded');
  });

  it('unknown suggestion → SUGGESTION_NOT_FOUND', async () => {
    const { discard } = setup();
    await expect(discard.execute('nope')).rejects.toMatchObject({ code: 'SUGGESTION_NOT_FOUND' });
  });
});

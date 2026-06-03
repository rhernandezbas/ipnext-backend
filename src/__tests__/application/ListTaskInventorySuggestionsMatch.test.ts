import { ListTaskInventorySuggestions } from '@application/use-cases/ListTaskInventorySuggestions';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

const sug = (over: Partial<TaskInventorySuggestion>): TaskInventorySuggestion => ({
  id: 's1', taskId: 't1', kind: 'DEVICE', deviceType: 'ROUTER', qwenDeviceType: null,
  serialNumber: null, mac: null,
  materialDesc: null, quantity: null, unit: null, source: 'OCR', photoUrl: null,
  status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z', ...over,
});

const makeItem = (over: Partial<ContractInstalledItem> = {}): ContractInstalledItem => ({
  id: 'i1', contractId: 'svc1', type: 'ROUTER', serialNumber: null, mac: null, model: null,
  source: 'MANUAL', sourceTaskId: null, addedByUserId: null, confirmedAt: null,
  status: 'active', notes: null, createdAt: 'x', updatedAt: 'x', ...over,
});

async function setup() {
  const suggestions = new InMemoryInventorySuggestionRepository();
  const inventory = new InMemoryContractInventoryRepository();
  const scheduling = new InMemorySchedulingRepository(new InMemoryStageRepository());
  const useCase = new ListTaskInventorySuggestions(suggestions, inventory, scheduling);
  return { suggestions, inventory, scheduling, useCase };
}

describe('ListTaskInventorySuggestions — computeMatch', () => {
  it('same_device by SN (normalisation: "abc-001" matches "ABC-001")', async () => {
    const { suggestions, inventory, scheduling, useCase } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeItem({ id: 'i1', serialNumber: 'ABC-001' }));
    await suggestions.upsert(sug({ id: 's1', serialNumber: 'abc-001' }));

    const result = await useCase.execute('t1');

    expect(result).toHaveLength(1);
    expect(result[0].match).not.toBeNull();
    expect(result[0].match!.status).toBe('same_device');
    expect(result[0].match!.itemId).toBe('i1');
  });

  it('same_device by MAC (suggestion mac "aa:bb:cc:dd:ee:ff" matches item "AABBCCDDEEFF" after strip)', async () => {
    const { suggestions, inventory, scheduling, useCase } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeItem({ id: 'i1', mac: 'AABBCCDDEEFF', serialNumber: 'DIFFERENT' }));
    await suggestions.upsert(sug({ id: 's1', mac: 'aa:bb:cc:dd:ee:ff', serialNumber: 'OTHER' }));

    const result = await useCase.execute('t1');

    expect(result[0].match).not.toBeNull();
    expect(result[0].match!.status).toBe('same_device');
    expect(result[0].match!.itemId).toBe('i1');
  });

  it('same_device by SN even when MAC differs', async () => {
    const { suggestions, inventory, scheduling, useCase } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeItem({ id: 'i1', serialNumber: 'SN123', mac: 'MAC1' }));
    await suggestions.upsert(sug({ id: 's1', serialNumber: 'SN123', mac: 'MAC_DIFFERENT' }));

    const result = await useCase.execute('t1');

    expect(result[0].match!.status).toBe('same_device');
  });

  it('same_type (same type, different SN/MAC)', async () => {
    const { suggestions, inventory, scheduling, useCase } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeItem({ id: 'i1', type: 'ROUTER', serialNumber: 'DIFFERENT_SN', mac: null }));
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'OTHER_SN', mac: null }));

    const result = await useCase.execute('t1');

    expect(result[0].match).not.toBeNull();
    expect(result[0].match!.status).toBe('same_type');
    expect(result[0].match!.itemId).toBe('i1');
  });

  it('null (no match on SN, MAC, or type)', async () => {
    const { suggestions, inventory, scheduling, useCase } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeItem({ id: 'i1', type: 'ONU', serialNumber: 'SN_ONU', mac: null }));
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'SN_ROUTER', mac: null }));

    const result = await useCase.execute('t1');

    expect(result[0].match).toBeNull();
  });

  it('MATERIAL suggestion → match always null', async () => {
    const { suggestions, inventory, scheduling, useCase } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeItem({ id: 'i1', type: 'ROUTER', serialNumber: 'SN1' }));
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', deviceType: null, serialNumber: null, mac: null,
      materialDesc: 'cable', quantity: 1, unit: 'm',
    }));

    const result = await useCase.execute('t1');

    expect(result[0].match).toBeNull();
  });

  it('removed item excluded → match null despite SN coincidence', async () => {
    const { suggestions, inventory, scheduling, useCase } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeItem({ id: 'i1', serialNumber: 'SN1', status: 'removed' }));
    await suggestions.upsert(sug({ id: 's1', serialNumber: 'SN1' }));

    const result = await useCase.execute('t1');

    expect(result[0].match).toBeNull();
  });

  it('task without contractId → all null, no error thrown', async () => {
    const { suggestions, scheduling, useCase } = await setup();
    scheduling.seedTask({ id: 't1', contractId: null });
    await suggestions.upsert(sug({ id: 's1', serialNumber: 'SN1' }));

    const result = await useCase.execute('t1');

    expect(result).toHaveLength(1);
    expect(result[0].match).toBeNull();
  });

  it('priority: same_device wins over same_type (SN + type both coincide → same_device)', async () => {
    const { suggestions, inventory, scheduling, useCase } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeItem({ id: 'i1', type: 'ROUTER', serialNumber: 'SN1' }));
    await suggestions.upsert(sug({ id: 's1', deviceType: 'ROUTER', serialNumber: 'SN1' }));

    const result = await useCase.execute('t1');

    expect(result[0].match!.status).toBe('same_device');
  });

  it('SN empty string after trim → treated as null (no match)', async () => {
    const { suggestions, inventory, scheduling, useCase } = await setup();
    scheduling.seedTask({ id: 't1', contractId: 'svc1' });
    await inventory.create(makeItem({ id: 'i1', serialNumber: '', mac: null, type: 'ONU' }));
    await suggestions.upsert(sug({ id: 's1', serialNumber: '   ', deviceType: 'ANTENA', mac: null }));

    const result = await useCase.execute('t1');

    // Empty SN normalises to null → no same_device. ONU vs ANTENA → no same_type.
    expect(result[0].match).toBeNull();
  });
});

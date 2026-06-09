import { CorrectConfirmedDeviceType } from '@application/use-cases/CorrectConfirmedDeviceType';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { TaskInventorySuggestion } from '@domain/entities/task-inventory-suggestion';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

const sug = (over: Partial<TaskInventorySuggestion>): TaskInventorySuggestion => ({
  id: 's1', taskId: 't1', kind: 'DEVICE', deviceType: 'ONU', qwenDeviceType: null,
  serialNumber: 'SN1', mac: null,
  materialDesc: null, quantity: null, unit: null, source: 'OCR', photoUrl: null,
  status: 'pending', confirmedItemId: null, createdAt: '2026-06-01T00:00:00Z', ...over,
});

const makeItem = (over: Partial<ContractInstalledItem> = {}): ContractInstalledItem => ({
  id: 'i1', contractId: 'svc1', type: 'ONU', serialNumber: 'SN1', mac: null, model: null,
  source: 'OCR', sourceTaskId: 't1', addedByUserId: null, confirmedAt: null,
  status: 'active', notes: null, replacesItemId: null, assetId: null, createdAt: 'x', updatedAt: 'x', ...over,
});

async function setup() {
  const suggestions = new InMemoryInventorySuggestionRepository();
  const inventory = new InMemoryContractInventoryRepository();
  const useCase = new CorrectConfirmedDeviceType(suggestions, inventory);
  return { suggestions, inventory, useCase };
}

describe('CorrectConfirmedDeviceType', () => {
  it('happy path — updates both suggestion.deviceType and item.type', async () => {
    const { suggestions, inventory, useCase } = await setup();
    await inventory.create(makeItem({ id: 'i1', type: 'ONU' }));
    await suggestions.upsert(sug({ id: 's1', status: 'confirmed', confirmedItemId: 'i1', deviceType: 'ONU' }));

    const result = await useCase.execute({ suggestionId: 's1', newType: 'ANTENA' });

    // Both records must be synced
    expect(result.type).toBe('ANTENA');
    const storedSuggestion = await suggestions.get('s1');
    expect(storedSuggestion!.deviceType).toBe('ANTENA');
    const storedItem = await inventory.getById('i1');
    expect(storedItem!.type).toBe('ANTENA');
  });

  it('guard: suggestionId not found → SUGGESTION_NOT_FOUND', async () => {
    const { useCase } = await setup();
    await expect(useCase.execute({ suggestionId: 'nope', newType: 'ANTENA' }))
      .rejects.toMatchObject({ code: 'SUGGESTION_NOT_FOUND' });
  });

  it('guard: suggestion is MATERIAL (not DEVICE) → SUGGESTION_NOT_A_DEVICE', async () => {
    const { suggestions, inventory, useCase } = await setup();
    await inventory.create(makeItem({ id: 'i1' }));
    await suggestions.upsert(sug({
      id: 's1', kind: 'MATERIAL', status: 'confirmed', confirmedItemId: 'i1',
      deviceType: null,
    }));
    await expect(useCase.execute({ suggestionId: 's1', newType: 'ANTENA' }))
      .rejects.toMatchObject({ code: 'SUGGESTION_NOT_A_DEVICE' });
  });

  it('guard: suggestion is pending (not confirmed) → SUGGESTION_NOT_CONFIRMED', async () => {
    const { suggestions, useCase } = await setup();
    await suggestions.upsert(sug({ id: 's1', status: 'pending', confirmedItemId: null }));
    await expect(useCase.execute({ suggestionId: 's1', newType: 'ANTENA' }))
      .rejects.toMatchObject({ code: 'SUGGESTION_NOT_CONFIRMED' });
  });

  it('guard: confirmedItemId is null (dirty data) → SUGGESTION_NOT_LINKED', async () => {
    const { suggestions, useCase } = await setup();
    await suggestions.upsert(sug({ id: 's1', kind: 'DEVICE', status: 'confirmed', confirmedItemId: null }));
    await expect(useCase.execute({ suggestionId: 's1', newType: 'ANTENA' }))
      .rejects.toMatchObject({ code: 'SUGGESTION_NOT_LINKED' });
  });

  it('guard: confirmedItemId points to deleted item → INSTALLED_ITEM_NOT_FOUND', async () => {
    const { suggestions, useCase } = await setup();
    await suggestions.upsert(sug({ id: 's1', status: 'confirmed', confirmedItemId: 'deleted-item' }));
    // item 'deleted-item' does NOT exist in inventory repo
    await expect(useCase.execute({ suggestionId: 's1', newType: 'ANTENA' }))
      .rejects.toMatchObject({ code: 'INSTALLED_ITEM_NOT_FOUND' });
  });

  it('return value: returns InstalledItemDto (addedByUserName null)', async () => {
    const { suggestions, inventory, useCase } = await setup();
    await inventory.create(makeItem({ id: 'i1', type: 'ONU' }));
    await suggestions.upsert(sug({ id: 's1', status: 'confirmed', confirmedItemId: 'i1' }));

    const result = await useCase.execute({ suggestionId: 's1', newType: 'ROUTER' });

    expect(result).toHaveProperty('addedByUserName', null);
    expect(result.id).toBe('i1');
    expect(result.type).toBe('ROUTER');
  });

  it('normalisation: use-case receives already-normalised UPPERCASE type and persists it as-is', async () => {
    const { suggestions, inventory, useCase } = await setup();
    await inventory.create(makeItem({ id: 'i1', type: 'ONU' }));
    await suggestions.upsert(sug({ id: 's1', status: 'confirmed', confirmedItemId: 'i1' }));

    const result = await useCase.execute({ suggestionId: 's1', newType: 'ANTENA' });

    expect(result.type).toBe('ANTENA');
    const storedSuggestion = await suggestions.get('s1');
    expect(storedSuggestion!.deviceType).toBe('ANTENA');
  });
});

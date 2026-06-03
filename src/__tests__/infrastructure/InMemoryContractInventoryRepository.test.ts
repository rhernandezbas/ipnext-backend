import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

function makeItem(overrides: Partial<ContractInstalledItem> = {}): ContractInstalledItem {
  return {
    id: 'item-1',
    contractId: 'contract-1',
    type: 'ONU',
    serialNumber: null,
    mac: null,
    model: null,
    source: 'MANUAL',
    sourceTaskId: null,
    addedByUserId: null,
    confirmedAt: null,
    status: 'active',
    notes: null,
    replacesItemId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('InMemoryContractInventoryRepository — getById and remove', () => {
  let repo: InMemoryContractInventoryRepository;

  beforeEach(() => {
    repo = new InMemoryContractInventoryRepository();
  });

  it('getById returns the item by id or null if not found', async () => {
    const item = makeItem({ id: 'item-1' });
    await repo.create(item);

    const found = await repo.getById('item-1');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('item-1');
    expect(found?.type).toBe('ONU');

    expect(await repo.getById('nonexistent')).toBeNull();
  });

  it('remove soft-deletes an active item (status -> removed)', async () => {
    const item = makeItem({ id: 'item-1', status: 'active' });
    await repo.create(item);

    const removed = await repo.remove('item-1');
    expect(removed).not.toBeNull();
    expect(removed?.status).toBe('removed');
    expect(removed?.id).toBe('item-1');

    // the stored item reflects removed status
    const stored = await repo.getById('item-1');
    expect(stored?.status).toBe('removed');
  });

  it('remove returns null for unknown id', async () => {
    const result = await repo.remove('nonexistent');
    expect(result).toBeNull();
  });
});

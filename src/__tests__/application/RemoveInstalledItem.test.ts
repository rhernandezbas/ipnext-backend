import { RemoveInstalledItem } from '@application/use-cases/RemoveInstalledItem';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

const makeItem = (over: Partial<ContractInstalledItem> = {}): ContractInstalledItem => ({
  id: 'i1',
  contractId: 'svc1',
  type: 'ROUTER',
  serialNumber: 'R1',
  mac: null,
  model: null,
  source: 'MANUAL',
  sourceTaskId: null,
  addedByUserId: null,
  confirmedAt: null,
  status: 'active',
  notes: null,
  replacesItemId: null,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  ...over,
});

describe('RemoveInstalledItem', () => {
  it('soft-deletes an active item (status → removed)', async () => {
    const repo = new InMemoryContractInventoryRepository();
    const useCase = new RemoveInstalledItem(repo);
    await repo.create(makeItem({ id: 'i1', status: 'active' }));

    const result = await useCase.execute('i1');
    expect(result.status).toBe('removed');
    expect(result.id).toBe('i1');
  });

  it('throws InstalledItemNotFoundError when item does not exist', async () => {
    const repo = new InMemoryContractInventoryRepository();
    const useCase = new RemoveInstalledItem(repo);
    await expect(useCase.execute('nonexistent'))
      .rejects.toMatchObject({ code: 'INSTALLED_ITEM_NOT_FOUND' });
  });

  it('is idempotent: removing an already-removed item is a no-op that returns the item', async () => {
    const repo = new InMemoryContractInventoryRepository();
    const useCase = new RemoveInstalledItem(repo);
    await repo.create(makeItem({ id: 'i1', status: 'removed' }));
    const result = await useCase.execute('i1');
    expect(result.status).toBe('removed');
    expect(result.id).toBe('i1');
  });

  it('is idempotent for a replaced item (no-op, no error)', async () => {
    const repo = new InMemoryContractInventoryRepository();
    const useCase = new RemoveInstalledItem(repo);
    await repo.create(makeItem({ id: 'i1', status: 'replaced' }));
    const result = await useCase.execute('i1');
    expect(result.status).toBe('replaced');
  });
});

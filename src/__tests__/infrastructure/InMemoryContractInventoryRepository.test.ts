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
    replacesItemId: null, assetId: null,
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

// service-transfer (W3) — reasignación de contrato del ítem instalado.
describe('InMemoryContractInventoryRepository — transferToContract', () => {
  let repo: InMemoryContractInventoryRepository;

  beforeEach(() => {
    repo = new InMemoryContractInventoryRepository();
  });

  it('mueve el ítem al contrato destino sin tocar el resto de los campos', async () => {
    await repo.create(makeItem({ id: 'item-1', contractId: 'contract-1', serialNumber: 'SN-1' }));

    await repo.transferToContract('item-1', 'contract-2');

    const moved = await repo.getById('item-1');
    expect(moved?.contractId).toBe('contract-2');
    expect(moved?.serialNumber).toBe('SN-1');
    expect(moved?.status).toBe('active');
  });

  it('lanza InstalledItemNotFoundError para un id desconocido (paridad con el adapter Prisma)', async () => {
    const { InstalledItemNotFoundError } = await import('@domain/errors/inventory');
    await expect(repo.transferToContract('nonexistent', 'contract-2'))
      .rejects.toThrow(InstalledItemNotFoundError);
  });

  // service-transfer fix wave L1 — el transfer es CONDICIONAL a status='active' (espejo del
  // updateMany WHERE status='active' del adapter Prisma): mata la ventana del retire concurrente
  // entre la validación del use case y la tx.
  it('L1: lanza InstalledItemAlreadyRemovedError si el ítem no está active y NO lo mueve', async () => {
    const { InstalledItemAlreadyRemovedError } = await import('@domain/errors/inventory');
    await repo.create(makeItem({ id: 'item-1', status: 'removed' }));
    await expect(repo.transferToContract('item-1', 'contract-2'))
      .rejects.toThrow(InstalledItemAlreadyRemovedError);
    expect((await repo.getById('item-1'))!.contractId).toBe('contract-1');
  });
});

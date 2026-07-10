/**
 * actions-worklist W2 — BAJA-1: listado computado con check de retiro.
 * Deriva del mirror (sin tabla propia): bajas recientes EXCLUYENDO titularidad,
 * check "orden de retiro" + conteo de equipos activos + nombre del cliente.
 */
import { ListRecentBajas } from '@application/use-cases/actions/ListRecentBajas';
import { InMemoryContractPairingReader } from '@infrastructure/adapters/in-memory/InMemoryContractPairingReader';
import { InMemoryRetirementOrderReader } from '@infrastructure/adapters/in-memory/InMemoryRetirementOrderReader';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { PairingContract } from '@domain/entities/ownershipCase';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';

function baja(id: string, clientId: string, overrides: Partial<PairingContract> = {}): PairingContract {
  return {
    id,
    clientId,
    address: 'MITRE 100',
    startDate: '2024-05-01T00:00:00.000Z',
    motivoBaja: 'MUDANZA',
    status: 'baja',
    ...overrides,
  };
}

function item(id: string, contractId: string, status: 'active' | 'removed' = 'active'): ContractInstalledItem {
  return {
    id,
    contractId,
    type: 'antena',
    serialNumber: null,
    mac: null,
    model: null,
    source: 'MANUAL',
    sourceTaskId: null,
    addedByUserId: null,
    confirmedAt: null,
    status,
    notes: null,
    replacesItemId: null,
    assetId: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

const CLIENT_NAMES: Record<string, string> = { 'cli-1': 'Carlos Baja', 'cli-2': 'Marta Baja' };

const clientLookup = {
  findById: async (id: string) =>
    CLIENT_NAMES[id] !== undefined ? { id, name: CLIENT_NAMES[id] } : null,
};

function build() {
  const pairingReader = new InMemoryContractPairingReader();
  const retirementReader = new InMemoryRetirementOrderReader();
  const inventoryRepo = new InMemoryContractInventoryRepository();
  const useCase = new ListRecentBajas(pairingReader, retirementReader, inventoryRepo, clientLookup);
  return { pairingReader, retirementReader, inventoryRepo, useCase };
}

describe('ListRecentBajas — check de retiro (BAJA-1)', () => {
  it('baja con ScheduledTask de proyecto retirement (match por contrato) → exists=true con taskId', async () => {
    const { pairingReader, retirementReader, useCase } = build();
    pairingReader.seed(baja('ct-1', 'cli-1'));
    retirementReader.seedTask({ id: 'task-9', contractId: 'ct-1', clientId: null, allowsEquipmentRetirement: true });

    const result = await useCase.execute({});

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.retirementOrder).toEqual({ exists: true, taskId: 'task-9' });
  });

  it('la task también matchea por CLIENTE (customerId) cuando el contrato no está linkeado', async () => {
    const { pairingReader, retirementReader, useCase } = build();
    pairingReader.seed(baja('ct-1', 'cli-1'));
    retirementReader.seedTask({ id: 'task-7', contractId: null, clientId: 'cli-1', allowsEquipmentRetirement: true });

    const result = await useCase.execute({});

    expect(result.items[0]!.retirementOrder).toEqual({ exists: true, taskId: 'task-7' });
  });

  it('baja sin orden y CON equipos activos → exists=false + conteo (la alarma operativa)', async () => {
    const { pairingReader, inventoryRepo, useCase } = build();
    pairingReader.seed(baja('ct-1', 'cli-1'));
    await inventoryRepo.create(item('i1', 'ct-1'));
    await inventoryRepo.create(item('i2', 'ct-1'));
    await inventoryRepo.create(item('i3', 'ct-1', 'removed')); // no cuenta

    const result = await useCase.execute({});

    const row = result.items[0]!;
    expect(row.retirementOrder.exists).toBe(false);
    expect(row.retirementOrder.taskId).toBeUndefined();
    expect(row.activeEquipmentCount).toBe(2);
  });

  it('una task de proyecto SIN allowsEquipmentRetirement NO cuenta como orden de retiro', async () => {
    const { pairingReader, retirementReader, useCase } = build();
    pairingReader.seed(baja('ct-1', 'cli-1'));
    retirementReader.seedTask({ id: 'task-x', contractId: 'ct-1', clientId: null, allowsEquipmentRetirement: false });

    const result = await useCase.execute({});

    expect(result.items[0]!.retirementOrder.exists).toBe(false);
  });
});

describe('ListRecentBajas — exclusión de titularidad (BAJA-1)', () => {
  it('las bajas con motivo CAMBIO DE TITULARIDAD NO aparecen (viven en el otro tab)', async () => {
    const { pairingReader, useCase } = build();
    pairingReader.seed(baja('ct-normal', 'cli-1', { motivoBaja: 'MUDANZA' }));
    pairingReader.seed(baja('ct-titu', 'cli-2', { motivoBaja: 'Baja por Cambio de Titularidad (venta)' }));

    const result = await useCase.execute({});

    expect(result.items.map((r) => r.contractId)).toEqual(['ct-normal']);
    expect(result.total).toBe(1);
  });
});

describe('ListRecentBajas — DTO y paginación', () => {
  it('enriquece con nombre del cliente (null si el lookup no matchea) + campos del contrato', async () => {
    const { pairingReader, useCase } = build();
    pairingReader.seed(baja('ct-1', 'cli-1', { motivoBaja: 'DEUDA' }));
    pairingReader.seed(baja('ct-2', 'cli-fantasma'));

    const result = await useCase.execute({});

    const byId = new Map(result.items.map((r) => [r.contractId, r]));
    const r1 = byId.get('ct-1')!;
    expect(r1.clientId).toBe('cli-1');
    expect(r1.clientName).toBe('Carlos Baja');
    expect(r1.motivoBaja).toBe('DEUDA');
    expect(r1.address).toBe('MITRE 100');
    expect(byId.get('ct-2')!.clientName).toBeNull();
  });

  it('pagina con total y hace echo de page/pageSize', async () => {
    const { pairingReader, useCase } = build();
    pairingReader.seed(baja('ct-1', 'cli-1'));
    pairingReader.seed(baja('ct-2', 'cli-1'));
    pairingReader.seed(baja('ct-3', 'cli-1'));

    const result = await useCase.execute({ page: 2, pageSize: 2 });

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(1);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(2);
  });

  // M5 — clamp del paging: el use case es la última línea (la route puede mentir).
  it('pageSize > 100 se clampa a 100', async () => {
    const { useCase } = build();

    const result = await useCase.execute({ pageSize: 500 });

    expect(result.pageSize).toBe(100);
  });

  it('pageSize negativo o NaN cae al default 25', async () => {
    const { useCase } = build();

    expect((await useCase.execute({ pageSize: -5 })).pageSize).toBe(25);
    expect((await useCase.execute({ pageSize: Number.NaN })).pageSize).toBe(25);
  });

  it('page negativa, cero o NaN cae al default 1', async () => {
    const { useCase } = build();

    expect((await useCase.execute({ page: -3 })).page).toBe(1);
    expect((await useCase.execute({ page: 0 })).page).toBe(1);
    expect((await useCase.execute({ page: Number.NaN })).page).toBe(1);
  });
});

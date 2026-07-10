/**
 * TransferContractEquipment.usecase.test.ts — unit tests del use case (service-transfer W3).
 *
 * TDD: escrito ANTES de la implementación. Repos in-memory (NUNCA Prisma mockeado).
 *
 * Contrato (spec EQ-1 + design §4):
 *   - happy 2 ítems: ambos pasan a contractId destino; el que tiene assetId genera UN
 *     InventoryMovement TRANSFER CLIENTE(A) → CLIENTE(B) (find-or-create ambas) y el asset
 *     queda con currentLocationId = CLIENTE(B); eventos transfer-out/in con lista en notes.
 *   - lote ATÓMICO: ítem ajeno / inactivo → falla completo ANTES de mover nada (cero moves,
 *     cero movimientos, cero eventos).
 *   - target == source → validación sin efectos · itemIds vacío → validación.
 *   - eventos best-effort: un eventRepo roto JAMÁS aborta la transferencia ya hecha.
 *   - rollback: fallo del ledger a mitad del lote → la tx del uow restaura TODO.
 */
import { TransferContractEquipment } from '@application/use-cases/TransferContractEquipment';
import { ResolveClientLocation } from '@application/use-cases/ResolveClientLocation';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { RecordMovementInput } from '@domain/ports/InventoryMovementRepository';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import {
  EquipmentTransferValidationError,
  InstalledItemAlreadyRemovedError,
  InstalledItemNotFoundError,
} from '@domain/errors/inventory';

const CONTRACTS: Record<string, { clientId: string; clientName: string | null }> = {
  'C-A': { clientId: 'cli-A', clientName: 'Perez Juan' },
  'C-B': { clientId: 'cli-B', clientName: 'Gomez Ana' },
  'C-X': { clientId: 'cli-X', clientName: 'Otro Cliente' },
};

const contractLookup = {
  findById: async (id: string) => (id in CONTRACTS ? { id, ...CONTRACTS[id]! } : null),
};

function makeItem(overrides: Partial<ContractInstalledItem> = {}): ContractInstalledItem {
  const now = new Date().toISOString();
  return {
    id: 'item-1',
    contractId: 'C-A',
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
    assetId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Ledger que explota al registrar el movimiento de UN assetId — para el test de rollback. */
class ExplodingMovementRepo extends InMemoryInventoryMovementRepository {
  explodeOnAssetId: string | null = null;
  async record(input: RecordMovementInput) {
    if (this.explodeOnAssetId && input.assetId === this.explodeOnAssetId) {
      throw new Error('ledger caído');
    }
    return super.record(input);
  }
}

interface Fixture {
  usecase: TransferContractEquipment;
  inventory: InMemoryContractInventoryRepository;
  locations: InMemoryStockLocationRepository;
  assets: InMemoryInventoryAssetRepository;
  movements: ExplodingMovementRepo;
  events: InMemoryContractServiceEventRepository;
  catalog: InMemoryServiceCatalogRepository;
}

async function buildFixture(opts: { brokenEvents?: boolean } = {}): Promise<Fixture> {
  const inventory = new InMemoryContractInventoryRepository();
  const suggestions = new InMemoryInventorySuggestionRepository();
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const materialStock = new InMemoryMaterialStockRepository();
  const movements = new ExplodingMovementRepo(assets, materialStock);
  const uow = new InMemoryUnitOfWork(suggestions, inventory, locations, assets, movements, materialStock);
  const catalog = new InMemoryServiceCatalogRepository();
  await catalog.create({ name: 'INTERNET', label: 'Internet', active: true, sortOrder: 1 });
  const events = new InMemoryContractServiceEventRepository();

  // Solo `record` importa: el use case no lee eventos. Un repo roto simula la DB de eventos caída.
  const eventRepo = opts.brokenEvents
    ? ({ record: async () => { throw new Error('event repo roto'); } } as unknown as InMemoryContractServiceEventRepository)
    : events;

  const usecase = new TransferContractEquipment(
    inventory,
    contractLookup,
    new ResolveClientLocation(locations),
    uow,
    catalog,
    eventRepo,
  );
  return { usecase, inventory, locations, assets, movements, events, catalog };
}

/** Seed: ítem CON asset instalado en la CLIENTE-location de su contrato. */
async function seedAssetItem(fx: Fixture, id: string, contractId: string): Promise<ContractInstalledItem> {
  const clientLoc = await new ResolveClientLocation(fx.locations).execute(contractId);
  const assetId = `asset-${id}`;
  fx.assets.store.set(assetId, createInventoryAsset({
    id: assetId,
    serialNumber: `SN-${id}`,
    mac: 'AA:BB:CC:00:11:22',
    deviceTypeId: 'dt-onu',
    status: 'installed',
    currentLocationId: clientLoc.id,
    source: 'MANUAL',
    sourceTaskId: null,
  }));
  const item = makeItem({ id, contractId, assetId, serialNumber: `SN-${id}`, mac: 'AA:BB:CC:00:11:22' });
  await fx.inventory.create(item);
  return item;
}

let warnSpy: jest.SpyInstance;
beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); });

describe('TransferContractEquipment — happy path (EQ-1)', () => {
  it('mueve 2 ítems (uno con asset → TRANSFER CLIENTE(A)→CLIENTE(B); otro sin asset → solo contractId)', async () => {
    const fx = await buildFixture();
    await seedAssetItem(fx, 'item-asset', 'C-A');
    await fx.inventory.create(makeItem({ id: 'item-bare', contractId: 'C-A', type: 'ROUTER', serialNumber: 'RT-9' }));

    const result = await fx.usecase.execute('C-A', {
      targetContractId: 'C-B',
      itemIds: ['item-asset', 'item-bare'],
      actorId: 'u1',
      actorName: 'operador',
    });

    // Ambos ítems quedaron en el contrato destino.
    expect((await fx.inventory.getById('item-asset'))!.contractId).toBe('C-B');
    expect((await fx.inventory.getById('item-bare'))!.contractId).toBe('C-B');

    // UN solo movimiento TRANSFER, de la CLIENTE-location de A a la de B (find-or-create).
    const sourceLoc = await fx.locations.findByTypeAndContract('CLIENTE', 'C-A');
    const targetLoc = await fx.locations.findByTypeAndContract('CLIENTE', 'C-B');
    expect(sourceLoc).not.toBeNull();
    expect(targetLoc).not.toBeNull();
    expect(fx.movements.movements).toHaveLength(1);
    const mv = fx.movements.movements[0]!;
    expect(mv.type).toBe('TRANSFER');
    expect(mv.assetId).toBe('asset-item-asset');
    expect(mv.fromLocationId).toBe(sourceLoc!.id);
    expect(mv.toLocationId).toBe(targetLoc!.id);

    // El asset se relocalizó a la CLIENTE-location del destino.
    expect((await fx.assets.findById('asset-item-asset'))!.currentLocationId).toBe(targetLoc!.id);

    // Resultado del contrato de wire.
    expect(result).toEqual({
      moved: 2,
      items: [
        { id: 'item-asset', type: 'ONU', assetMoved: true },
        { id: 'item-bare', type: 'ROUTER', assetMoved: false },
      ],
    });

    // Eventos transfer-out (origen) / transfer-in (destino) con snapshot de nombres + lista.
    const all = fx.events.all();
    expect(all).toHaveLength(2);
    const out = all.find(e => e.changeKind === 'transfer-out')!;
    const inn = all.find(e => e.changeKind === 'transfer-in')!;
    expect(out.contractId).toBe('C-A');
    expect(inn.contractId).toBe('C-B');
    for (const e of [out, inn]) {
      expect(e.eventType).toBe('modified');
      expect(e.oldValue).toBe('Perez Juan');
      expect(e.newValue).toBe('Gomez Ana');
      expect(e.actorId).toBe('u1');
      expect(e.actorName).toBe('operador');
      expect(e.notes).toContain('Equipos:');
      expect(e.notes).toContain('ONU SN-item-asset/AA:BB:CC:00:11:22');
      expect(e.notes).toContain('ROUTER RT-9');
    }
  });
});

describe('TransferContractEquipment — lote atómico (guards ANTES de mover nada)', () => {
  it('ítem ajeno al source → InstalledItemNotFoundError y NINGÚN ítem movido, cero movimientos, cero eventos', async () => {
    const fx = await buildFixture();
    await seedAssetItem(fx, 'item-ok', 'C-A');
    await fx.inventory.create(makeItem({ id: 'item-ajeno', contractId: 'C-X' }));

    await expect(
      fx.usecase.execute('C-A', { targetContractId: 'C-B', itemIds: ['item-ok', 'item-ajeno'] }),
    ).rejects.toThrow(InstalledItemNotFoundError);

    expect((await fx.inventory.getById('item-ok'))!.contractId).toBe('C-A');
    expect((await fx.inventory.getById('item-ajeno'))!.contractId).toBe('C-X');
    expect(fx.movements.movements).toHaveLength(0);
    expect(fx.events.all()).toHaveLength(0);
  });

  it('ítem inactivo (removed) → InstalledItemAlreadyRemovedError, falla completo sin efectos', async () => {
    const fx = await buildFixture();
    await seedAssetItem(fx, 'item-ok', 'C-A');
    await fx.inventory.create(makeItem({ id: 'item-removed', contractId: 'C-A', status: 'removed' }));

    await expect(
      fx.usecase.execute('C-A', { targetContractId: 'C-B', itemIds: ['item-ok', 'item-removed'] }),
    ).rejects.toThrow(InstalledItemAlreadyRemovedError);

    expect((await fx.inventory.getById('item-ok'))!.contractId).toBe('C-A');
    expect(fx.movements.movements).toHaveLength(0);
    expect(fx.events.all()).toHaveLength(0);
  });

  it('ítem inexistente → InstalledItemNotFoundError sin efectos', async () => {
    const fx = await buildFixture();
    await seedAssetItem(fx, 'item-ok', 'C-A');

    await expect(
      fx.usecase.execute('C-A', { targetContractId: 'C-B', itemIds: ['ghost', 'item-ok'] }),
    ).rejects.toThrow(InstalledItemNotFoundError);

    expect((await fx.inventory.getById('item-ok'))!.contractId).toBe('C-A');
    expect(fx.movements.movements).toHaveLength(0);
    expect(fx.events.all()).toHaveLength(0);
  });

  it('rollback: el ledger explota a mitad del lote → la tx restaura TODO (ningún ítem queda movido)', async () => {
    const fx = await buildFixture();
    // Orden de proceso: primero el ítem SIN asset (se mueve), después el que explota en el ledger.
    await fx.inventory.create(makeItem({ id: 'item-bare', contractId: 'C-A' }));
    await seedAssetItem(fx, 'item-boom', 'C-A');
    fx.movements.explodeOnAssetId = 'asset-item-boom';

    await expect(
      fx.usecase.execute('C-A', { targetContractId: 'C-B', itemIds: ['item-bare', 'item-boom'] }),
    ).rejects.toThrow('ledger caído');

    expect((await fx.inventory.getById('item-bare'))!.contractId).toBe('C-A');
    expect((await fx.inventory.getById('item-boom'))!.contractId).toBe('C-A');
    expect(fx.movements.movements).toHaveLength(0);
    expect(fx.events.all()).toHaveLength(0);
  });

  // fix wave L1 — el retire gana la carrera ENTRE la validación (guard 5 leyó 'active') y la tx:
  // el transferToContract condicional (WHERE status='active') debe fallar tipado y no mover nada.
  it('L1: retire concurrente post-validación → InstalledItemAlreadyRemovedError y nada se mueve', async () => {
    const fx = await buildFixture();
    // El store REAL tiene el ítem 'removed' (el retire ya corrió)…
    await fx.inventory.create(makeItem({ id: 'it-race', contractId: 'C-A', status: 'removed' }));
    // …pero el guard del use case leyó un snapshot stale 'active' (simula la ventana TOCTOU).
    const getByIdSpy = jest.spyOn(fx.inventory, 'getById').mockResolvedValue(
      makeItem({ id: 'it-race', contractId: 'C-A', status: 'active' }),
    );

    await expect(
      fx.usecase.execute('C-A', { targetContractId: 'C-B', itemIds: ['it-race'] }),
    ).rejects.toBeInstanceOf(InstalledItemAlreadyRemovedError);

    // Nada se movió ni se registró: la fila sigue removed en C-A.
    getByIdSpy.mockRestore();
    expect((await fx.inventory.getById('it-race'))!.contractId).toBe('C-A');
    expect((await fx.inventory.getById('it-race'))!.status).toBe('removed');
    expect(fx.movements.movements).toHaveLength(0);
    expect(fx.events.all()).toHaveLength(0);
  });
});

describe('TransferContractEquipment — validaciones y contratos', () => {
  it('target == source → EquipmentTransferValidationError sin efectos', async () => {
    const fx = await buildFixture();
    await seedAssetItem(fx, 'item-1', 'C-A');

    await expect(
      fx.usecase.execute('C-A', { targetContractId: 'C-A', itemIds: ['item-1'] }),
    ).rejects.toThrow(EquipmentTransferValidationError);

    expect((await fx.inventory.getById('item-1'))!.contractId).toBe('C-A');
    expect(fx.movements.movements).toHaveLength(0);
    expect(fx.events.all()).toHaveLength(0);
  });

  it('itemIds vacío → EquipmentTransferValidationError', async () => {
    const fx = await buildFixture();
    await expect(
      fx.usecase.execute('C-A', { targetContractId: 'C-B', itemIds: [] }),
    ).rejects.toThrow(EquipmentTransferValidationError);
    expect(fx.events.all()).toHaveLength(0);
  });

  it('source contract inexistente → ContractNotFoundError', async () => {
    const fx = await buildFixture();
    await expect(
      fx.usecase.execute('ghost', { targetContractId: 'C-B', itemIds: ['x'] }),
    ).rejects.toThrow(ContractNotFoundError);
  });

  it('target contract inexistente → ContractNotFoundError', async () => {
    const fx = await buildFixture();
    await expect(
      fx.usecase.execute('C-A', { targetContractId: 'ghost', itemIds: ['x'] }),
    ).rejects.toThrow(ContractNotFoundError);
  });
});

describe('TransferContractEquipment — eventos best-effort', () => {
  it('eventRepo roto → la transferencia igual completa (warn, sin throw)', async () => {
    const fx = await buildFixture({ brokenEvents: true });
    await seedAssetItem(fx, 'item-1', 'C-A');

    const result = await fx.usecase.execute('C-A', { targetContractId: 'C-B', itemIds: ['item-1'] });

    expect(result.moved).toBe(1);
    expect((await fx.inventory.getById('item-1'))!.contractId).toBe('C-B');
    expect(fx.movements.movements).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });
});

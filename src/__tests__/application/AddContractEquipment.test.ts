import { AddContractEquipment } from '@application/use-cases/AddContractEquipment';
import { InstallContractAsset } from '@application/services/InstallContractAsset';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { createStockLocation } from '@domain/entities/stock-location';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import {
  SameTypeNeedsDecisionError,
  AssetInstalledElsewhereError,
  AssetNotRevivableError,
  InstalledItemNotFoundError,
} from '@domain/errors/inventory';
import {
  InventoryMovementRepository,
  RecordMovementInput,
  MovementFilters,
} from '@domain/ports/InventoryMovementRepository';
import { InventoryMovement } from '@domain/entities/inventory-movement';

const BASE_TYPES = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];

/** Decorator that throws once on record() — for atomicity/rollback tests. */
class FailingMovementRepo implements InventoryMovementRepository {
  failNext = false;
  constructor(private readonly inner: InMemoryInventoryMovementRepository) {}
  get movements(): InventoryMovement[] {
    return this.inner.movements;
  }
  async record(input: RecordMovementInput): Promise<InventoryMovement> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('INJECTED movement failure');
    }
    return this.inner.record(input);
  }
  async listByAsset(assetId: string): Promise<InventoryMovement[]> {
    return this.inner.listByAsset(assetId);
  }
  async findBySourceRef(sourceRef: string): Promise<InventoryMovement | null> {
    return this.inner.findBySourceRef(sourceRef);
  }
  async listMovements(filters: MovementFilters, page: number, limit: number) {
    return this.inner.listMovements(filters, page, limit);
  }
}

async function setup() {
  const inventory = new InMemoryContractInventoryRepository();
  const suggestions = new InMemoryInventorySuggestionRepository();
  const catalog = new InMemoryDeviceTypeCatalogRepository();
  for (const name of BASE_TYPES) await catalog.create({ name, active: true, sortOrder: 0 });
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const materialStock = new InMemoryMaterialStockRepository();
  const innerMovements = new InMemoryInventoryMovementRepository(assets, materialStock);
  const movements = new FailingMovementRepo(innerMovements);
  const uow = new InMemoryUnitOfWork(suggestions, inventory, locations, assets, movements, materialStock);
  const install = new InstallContractAsset(catalog);
  const add = new AddContractEquipment(
    inventory,
    catalog,
    locations,
    assets,
    movements,
    uow,
    install,
  );
  return { add, inventory, catalog, locations, assets, innerMovements, movements, uow };
}

/** Seed a pre-existing CII directly into the repo. */
const seedItem = async (
  inventory: InMemoryContractInventoryRepository,
  over: Partial<ContractInstalledItem>,
): Promise<ContractInstalledItem> => {
  const now = '2026-06-01T00:00:00Z';
  return inventory.create({
    id: over.id ?? 'seed1',
    contractId: over.contractId ?? 'C1',
    type: over.type ?? 'ANTENA',
    serialNumber: over.serialNumber ?? null,
    mac: over.mac ?? null,
    model: over.model ?? null,
    source: over.source ?? 'MANUAL',
    sourceTaskId: over.sourceTaskId ?? null,
    addedByUserId: over.addedByUserId ?? null,
    confirmedAt: over.confirmedAt ?? now,
    status: over.status ?? 'active',
    notes: over.notes ?? null,
    replacesItemId: over.replacesItemId ?? null,
    assetId: over.assetId ?? null,
    createdAt: over.createdAt ?? now,
    updatedAt: over.updatedAt ?? now,
  });
};

describe('AddContractEquipment', () => {
  // ── same_device → enrich (200, no new row) ──────────────────────────────────
  it('enriches an ACTIVE item whose MAC already exists (no new row, fills null model)', async () => {
    const { add, inventory } = await setup();
    await seedItem(inventory, { id: 'a1', type: 'ANTENA', mac: '78:8A:20:96:6A:AE', model: null });

    const res = await add.execute({
      contractId: 'C1',
      type: 'ANTENA',
      mac: '78:8a:20:96:6a:ae',
      model: 'LiteBeam 5AC Gen2',
    });

    expect(res.created).toBe(false);
    expect(res.item.id).toBe('a1');
    expect(res.item.model).toBe('LiteBeam 5AC Gen2');
    expect(res.item.mac).toBe('78:8A:20:96:6A:AE');
    const all = await inventory.listByContract('C1');
    expect(all).toHaveLength(1);
  });

  it('revives a REMOVED item whose MAC matches (status→active, no new row/asset)', async () => {
    const { add, inventory, assets } = await setup();
    await seedItem(inventory, { id: 'r1', type: 'ANTENA', mac: '78:8A:20:96:6A:AE', status: 'removed' });

    const res = await add.execute({ contractId: 'C1', type: 'ANTENA', mac: '78:8A:20:96:6A:AE' });

    expect(res.created).toBe(false);
    expect(res.item.id).toBe('r1');
    expect(res.item.status).toBe('active');
    const all = await inventory.listByContract('C1');
    expect(all).toHaveLength(1);
    // A legacy item with no asset gets one materialized on revive (traceability).
    expect(res.item.assetId).not.toBeNull();
    expect(assets.store.size).toBe(1);
  });

  // ── REMOVED item WITH a linked REMOVED asset (the real-world bug) ─────────────
  // Reproduces the CRITICAL bug: a CII removed + its linked InventoryAsset removed
  // (reachable via ConfirmInventorySuggestion replace / RetireContractEquipment).
  // "Agregar por PPPoE" with the same MAC → same_device → enrich → reconcileForEnrich
  // hits the removed-asset branch (asset.assetId is NOT null). The old code called
  // nextStatus('removed','available') which threw InvalidStatusTransitionError, the
  // tx rolled back and the POST 400'd. The equipment must instead be revived to
  // installed @ the contract's CLIENTE location with an INSTALL movement.
  it('revives a REMOVED item whose linked asset is REMOVED (asset → installed @ CLIENTE + INSTALL movement)', async () => {
    const { add, inventory, assets, innerMovements, locations } = await setup();

    // Removed asset sitting at the DEPOSITO (e.g. after a retire/replace).
    const depot = await locations.create(
      createStockLocation({ id: 'L-depot', type: 'DEPOSITO', code: 'DEPOSITO' }),
    );
    await assets.create(
      createInventoryAsset({
        id: 'asset-removed',
        serialNumber: 'SN-REM-1',
        mac: '78:8A:20:96:6A:AE',
        deviceTypeId: 'dt',
        status: 'removed',
        currentLocationId: depot.id,
        source: 'MANUAL',
      }),
    );
    // Removed CII linked to that removed asset.
    await seedItem(inventory, {
      id: 'r2',
      type: 'ANTENA',
      mac: '78:8A:20:96:6A:AE',
      status: 'removed',
      assetId: 'asset-removed',
    });

    const res = await add.execute({ contractId: 'C1', type: 'ANTENA', mac: '78:8A:20:96:6A:AE' });

    // Item revived in place — no new row.
    expect(res.created).toBe(false);
    expect(res.item.id).toBe('r2');
    expect(res.item.status).toBe('active');
    expect(await inventory.listByContract('C1')).toHaveLength(1);

    // The SAME asset was revived (no duplicate created).
    expect(assets.store.size).toBe(1);
    const asset = await assets.findById('asset-removed');
    expect(asset!.status).toBe('installed');
    const cliente = await locations.findByTypeAndContract('CLIENTE', 'C1');
    expect(asset!.currentLocationId).toBe(cliente!.id);

    // INSTALL movement recorded, depot → client.
    const moves = await innerMovements.listByAsset('asset-removed');
    expect(moves).toHaveLength(1);
    expect(moves[0].type).toBe('INSTALL');
    expect(moves[0].toLocationId).toBe(cliente!.id);
  });

  it('matches by SN even when the MAC differs (same_device by serial), fills the mac', async () => {
    const { add, inventory } = await setup();
    await seedItem(inventory, { id: 's1', type: 'ANTENA', serialNumber: 'SN-001', mac: null });

    const res = await add.execute({
      contractId: 'C1',
      type: 'ANTENA',
      serialNumber: 'sn001',
      mac: 'AA:BB:CC:DD:EE:FF',
    });

    expect(res.created).toBe(false);
    expect(res.item.id).toBe('s1');
    expect(res.item.mac).toBe('AA:BB:CC:DD:EE:FF');
    expect(await inventory.listByContract('C1')).toHaveLength(1);
  });

  it('enrich does NOT overwrite existing non-null fields', async () => {
    const { add, inventory } = await setup();
    await seedItem(inventory, { id: 'm1', type: 'ROUTER', mac: 'C0:C9:E3:34:33:75', model: 'TP-Link Archer' });

    const res = await add.execute({
      contractId: 'C1',
      type: 'ROUTER',
      mac: 'c0:c9:e3:34:33:75',
      model: 'Otro',
    });

    expect(res.created).toBe(false);
    expect(res.item.model).toBe('TP-Link Archer');
  });

  // ── new (201, dual-write) ───────────────────────────────────────────────────
  it('creates a new item + asset + INSTALL movement when nothing matches (with SN)', async () => {
    const { add, inventory, assets, innerMovements, locations } = await setup();

    const res = await add.execute({
      contractId: 'C1',
      type: 'ROUTER',
      serialNumber: 'ABC123',
      mac: 'C0:C9:E3:34:33:75',
      model: 'TP-Link',
    });

    expect(res.created).toBe(true);
    expect(res.item.assetId).not.toBeNull();
    const asset = await assets.findBySerialNumber('ABC123');
    expect(asset).not.toBeNull();
    expect(asset!.status).toBe('installed');
    const cliente = await locations.findByTypeAndContract('CLIENTE', 'C1');
    expect(asset!.currentLocationId).toBe(cliente!.id);
    const moves = await innerMovements.listByAsset(asset!.id);
    expect(moves).toHaveLength(1);
    expect(moves[0].type).toBe('INSTALL');
    expect(await inventory.listByContract('C1')).toHaveLength(1);
  });

  it('creates MAC-only equipment with a synthesized CII- serial (201)', async () => {
    const { add, assets } = await setup();

    const res = await add.execute({ contractId: 'C1', type: 'ROUTER', mac: 'c0:c9:e3:34:33:75' });

    expect(res.created).toBe(true);
    expect(res.item.assetId).not.toBeNull();
    const asset = await assets.findById(res.item.assetId!);
    expect(asset!.serialNumber).toMatch(/^CII-/);
    expect(asset!.mac).toBe('c0:c9:e3:34:33:75');
  });

  it('is atomic — a failing movement rolls back the item AND the asset', async () => {
    const { add, inventory, assets, innerMovements, movements } = await setup();
    movements.failNext = true;

    await expect(
      add.execute({ contractId: 'C1', type: 'ROUTER', serialNumber: 'ABC123' }),
    ).rejects.toThrow('INJECTED movement failure');

    expect(await inventory.listByContract('C1')).toHaveLength(0);
    expect(assets.store.size).toBe(0);
    expect(innerMovements.movements).toHaveLength(0);
  });

  it('refuses when the MAC belongs to an asset installed in ANOTHER contract', async () => {
    const { add, locations, assets } = await setup();
    // Asset installed at OTHER contract's CLIENTE location.
    const otherLoc = await locations.create(createStockLocation({ id: 'L-other', type: 'CLIENTE', contractId: 'C2' }));
    await assets.create(
      createInventoryAsset({
        id: 'as-other',
        serialNumber: 'OTHER-SN',
        mac: 'AA:BB:CC:DD:EE:FF',
        deviceTypeId: 'dt',
        status: 'installed',
        currentLocationId: otherLoc.id,
        source: 'MANUAL',
      }),
    );

    await expect(
      add.execute({ contractId: 'C1', type: 'ROUTER', mac: 'aa:bb:cc:dd:ee:ff' }),
    ).rejects.toBeInstanceOf(AssetInstalledElsewhereError);
  });

  // ── same_type → operator decision ───────────────────────────────────────────
  it('throws SameTypeNeedsDecisionError when only the type matches (no completeItemId/force)', async () => {
    const { add, inventory } = await setup();
    await seedItem(inventory, { id: 'ant', type: 'ANTENA', serialNumber: 'SN-001', mac: null });

    let thrown: unknown;
    try {
      await add.execute({ contractId: 'C1', type: 'ANTENA', mac: '78:8A:20:96:6A:AE' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SameTypeNeedsDecisionError);
    const err = thrown as SameTypeNeedsDecisionError;
    expect(err.candidates).toHaveLength(1);
    expect(err.candidates[0]).toMatchObject({ id: 'ant', type: 'ANTENA', serialNumber: 'SN-001', mac: null });
    // Nothing created.
    expect(await inventory.listByContract('C1')).toHaveLength(1);
  });

  it('completeItemId enriches the chosen same_type item (200, no new row)', async () => {
    const { add, inventory } = await setup();
    await seedItem(inventory, { id: 'ant', type: 'ANTENA', serialNumber: 'SN-001', mac: null });

    const res = await add.execute({
      contractId: 'C1',
      type: 'ANTENA',
      mac: '78:8A:20:96:6A:AE',
      completeItemId: 'ant',
    });

    expect(res.created).toBe(false);
    expect(res.item.id).toBe('ant');
    expect(res.item.mac).toBe('78:8A:20:96:6A:AE');
    expect(await inventory.listByContract('C1')).toHaveLength(1);
  });

  it('completeItemId is contract-scoped — an item from ANOTHER contract is 404, not enriched', async () => {
    const { add, inventory } = await setup();
    // The chosen item lives under contract C2, but the add targets C1.
    await seedItem(inventory, { id: 'foreign', contractId: 'C2', type: 'ANTENA', serialNumber: 'SN-FOREIGN', mac: null });
    // A same_type item under C1 so the add reaches the completeItemId branch (not create).
    await seedItem(inventory, { id: 'local', contractId: 'C1', type: 'ANTENA', serialNumber: 'SN-LOCAL', mac: null });

    let thrown: unknown;
    try {
      await add.execute({
        contractId: 'C1',
        type: 'ANTENA',
        mac: '78:8A:20:96:6A:AE',
        completeItemId: 'foreign', // not in C1's list → must 404
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InstalledItemNotFoundError);
    // The foreign item was NOT touched.
    const foreign = (await inventory.listByContract('C2')).find((i) => i.id === 'foreign');
    expect(foreign!.mac).toBeNull();
  });

  it('refuses to revive a DAMAGED linked asset (AssetNotRevivableError → 409)', async () => {
    const { add, inventory, assets, locations } = await setup();
    const depot = await locations.create(
      createStockLocation({ id: 'L-depot', type: 'DEPOSITO', code: 'DEPOSITO' }),
    );
    await assets.create(
      createInventoryAsset({
        id: 'asset-damaged',
        serialNumber: 'SN-DMG-1',
        mac: '78:8A:20:96:6A:AE',
        deviceTypeId: 'dt',
        status: 'damaged',
        currentLocationId: depot.id,
        source: 'MANUAL',
      }),
    );
    await seedItem(inventory, {
      id: 'd1',
      type: 'ANTENA',
      mac: '78:8A:20:96:6A:AE',
      status: 'removed',
      assetId: 'asset-damaged',
    });

    await expect(
      add.execute({ contractId: 'C1', type: 'ANTENA', mac: '78:8A:20:96:6A:AE' }),
    ).rejects.toBeInstanceOf(AssetNotRevivableError);

    // Atomic: nothing changed — asset still damaged, item still removed.
    const asset = await assets.findById('asset-damaged');
    expect(asset!.status).toBe('damaged');
    const item = (await inventory.listByContract('C1')).find((i) => i.id === 'd1');
    expect(item!.status).toBe('removed');
  });

  it('force creates a second item of the same type (201)', async () => {
    const { add, inventory } = await setup();
    await seedItem(inventory, { id: 'ant', type: 'ANTENA', serialNumber: 'SN-001', mac: null });

    const res = await add.execute({
      contractId: 'C1',
      type: 'ANTENA',
      mac: '78:8A:20:96:6A:AE',
      force: true,
    });

    expect(res.created).toBe(true);
    const all = await inventory.listByContract('C1');
    expect(all.filter((i) => i.type === 'ANTENA')).toHaveLength(2);
  });

  it('same_device wins over force (still enriches, never duplicates)', async () => {
    const { add, inventory } = await setup();
    await seedItem(inventory, { id: 'a1', type: 'ANTENA', mac: 'AA:BB:CC:DD:EE:FF' });

    const res = await add.execute({
      contractId: 'C1',
      type: 'ANTENA',
      mac: 'aa:bb:cc:dd:ee:ff',
      force: true,
    });

    expect(res.created).toBe(false);
    expect(res.item.id).toBe('a1');
    expect(await inventory.listByContract('C1')).toHaveLength(1);
  });

  it('same_device wins over completeItemId pointing elsewhere (physical identity manda)', async () => {
    const { add, inventory } = await setup();
    await seedItem(inventory, { id: 'a1', type: 'ANTENA', mac: 'AA:BB:CC:DD:EE:FF' });
    await seedItem(inventory, { id: 'a2', type: 'ANTENA', serialNumber: 'SN-OTHER', mac: null });

    const res = await add.execute({
      contractId: 'C1',
      type: 'ANTENA',
      mac: 'aa:bb:cc:dd:ee:ff',
      completeItemId: 'a2',
    });

    expect(res.created).toBe(false);
    expect(res.item.id).toBe('a1'); // matched the physical device, not the chosen one
  });

  it('works without dual-write wiring (catalog only) — creates the item, assetId null', async () => {
    const inventory = new InMemoryContractInventoryRepository();
    const catalog = new InMemoryDeviceTypeCatalogRepository();
    for (const name of BASE_TYPES) await catalog.create({ name, active: true, sortOrder: 0 });
    const add = new AddContractEquipment(inventory, catalog);

    const res = await add.execute({ contractId: 'C1', type: 'ROUTER', serialNumber: 'NOLEDGER' });

    expect(res.created).toBe(true);
    expect(res.item.assetId).toBeNull();
    expect(res.item.source).toBe('MANUAL');
  });
});

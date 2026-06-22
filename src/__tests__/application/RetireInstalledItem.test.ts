import { RetireInstalledItem } from '@application/use-cases/RetireInstalledItem';
import { RouteAssetToDisposition } from '@application/services/RouteAssetToDisposition';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { ResolveClientLocation } from '@application/use-cases/ResolveClientLocation';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { InstalledItemNotFoundError, TechnicianRequiredError, AssetNotInstalledError } from '@domain/errors/inventory';
import {
  InventoryMovementRepository,
  RecordMovementInput,
  MovementFilters,
} from '@domain/ports/InventoryMovementRepository';
import { InventoryMovement } from '@domain/entities/inventory-movement';

const CONTRACT_ID = 'C1';
const TECH_ID = 't1';

/** Decorator that throws once on record() — for the atomicity/rollback test. */
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
  const locations = new InMemoryStockLocationRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const materialStock = new InMemoryMaterialStockRepository();
  const innerMovements = new InMemoryInventoryMovementRepository(assets, materialStock);
  const movements = new FailingMovementRepo(innerMovements);
  const uow = new InMemoryUnitOfWork(suggestions, inventory, locations, assets, movements, materialStock);

  const resolveClient = new ResolveClientLocation(locations);
  const route = new RouteAssetToDisposition(
    new ResolveDepotLocation(locations),
    new ResolveTechnicianLocation(locations),
    resolveClient,
  );

  const retire = new RetireInstalledItem(inventory, route, uow);

  return { retire, inventory, locations, assets, innerMovements, movements, resolveClient };
}

/** Seed a CII directly into the repo (active, no asset by default). */
const seedItem = async (
  inventory: InMemoryContractInventoryRepository,
  over: Partial<ContractInstalledItem>,
): Promise<ContractInstalledItem> => {
  const now = '2026-06-01T00:00:00Z';
  return inventory.create({
    id: over.id ?? 'i1',
    contractId: over.contractId ?? CONTRACT_ID,
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

/**
 * Seed an `installed` asset @ the contract's CLIENTE location and a CII linked to it.
 * Returns the item id and asset id.
 */
async function seedItemWithAsset(
  inventory: InMemoryContractInventoryRepository,
  resolveClient: ResolveClientLocation,
  assets: InMemoryInventoryAssetRepository,
  over: Partial<ContractInstalledItem> = {},
): Promise<{ itemId: string; assetId: string; clienteId: string }> {
  const cliente = await resolveClient.execute(CONTRACT_ID);
  const assetId = `asset-${over.id ?? 'i1'}`;
  await assets.create(
    createInventoryAsset({
      id: assetId,
      serialNumber: `SN-${over.id ?? 'i1'}`,
      mac: null,
      deviceTypeId: 'dt',
      status: 'installed',
      currentLocationId: cliente.id,
      source: 'MANUAL',
    }),
  );
  const item = await seedItem(inventory, { ...over, assetId });
  return { itemId: item.id, assetId, clienteId: cliente.id };
}

describe('RetireInstalledItem', () => {
  // ── 5 happy dispositions ────────────────────────────────────────────────────
  it('DEPOSITO → item removed, asset available @ DEPOSITO + RETURN movement', async () => {
    const { retire, inventory, assets, innerMovements, locations, resolveClient } = await setup();
    const { itemId, assetId } = await seedItemWithAsset(inventory, resolveClient, assets);

    const result = await retire.execute({ contractId: CONTRACT_ID, itemId, disposition: 'DEPOSITO' });

    expect(result.status).toBe('removed');
    const depot = await locations.findByCode('DEPOSITO');
    const asset = await assets.findById(assetId);
    expect(asset!.status).toBe('available');
    expect(asset!.currentLocationId).toBe(depot!.id);
    const moves = await innerMovements.listByAsset(assetId);
    expect(moves).toHaveLength(1);
    expect(moves[0].type).toBe('RETURN');
  });

  it('TECNICO → asset available @ technician location + TRANSFER with technicianId', async () => {
    const { retire, inventory, assets, innerMovements, locations, resolveClient } = await setup();
    const { itemId, assetId } = await seedItemWithAsset(inventory, resolveClient, assets);

    await retire.execute({ contractId: CONTRACT_ID, itemId, disposition: 'TECNICO', technicianId: TECH_ID });

    const techLoc = await locations.findByTypeAndTechnician('TECNICO', TECH_ID);
    const asset = await assets.findById(assetId);
    expect(asset!.status).toBe('available');
    expect(asset!.currentLocationId).toBe(techLoc!.id);
    const moves = await innerMovements.listByAsset(assetId);
    expect(moves[0].type).toBe('TRANSFER');
    expect(moves[0].technicianId).toBe(TECH_ID);
  });

  it('CLIENTE → asset retired, stays @ CLIENTE + ADJUST movement', async () => {
    const { retire, inventory, assets, innerMovements, resolveClient } = await setup();
    const { itemId, assetId, clienteId } = await seedItemWithAsset(inventory, resolveClient, assets);

    await retire.execute({ contractId: CONTRACT_ID, itemId, disposition: 'CLIENTE' });

    const asset = await assets.findById(assetId);
    expect(asset!.status).toBe('retired');
    expect(asset!.currentLocationId).toBe(clienteId);
    const moves = await innerMovements.listByAsset(assetId);
    expect(moves[0].type).toBe('ADJUST');
    expect(moves[0].status).toBe('retired');
  });

  it('DAMAGED → asset damaged @ DEPOSITO + ADJUST movement', async () => {
    const { retire, inventory, assets, innerMovements, locations, resolveClient } = await setup();
    const { itemId, assetId } = await seedItemWithAsset(inventory, resolveClient, assets);

    await retire.execute({ contractId: CONTRACT_ID, itemId, disposition: 'DAMAGED' });

    const depot = await locations.findByCode('DEPOSITO');
    const asset = await assets.findById(assetId);
    expect(asset!.status).toBe('damaged');
    expect(asset!.currentLocationId).toBe(depot!.id);
    const moves = await innerMovements.listByAsset(assetId);
    expect(moves[0].type).toBe('ADJUST');
    expect(moves[0].status).toBe('damaged');
  });

  it('RETIRED → asset retired @ DEPOSITO + ADJUST movement', async () => {
    const { retire, inventory, assets, innerMovements, locations, resolveClient } = await setup();
    const { itemId, assetId } = await seedItemWithAsset(inventory, resolveClient, assets);

    await retire.execute({ contractId: CONTRACT_ID, itemId, disposition: 'RETIRED', note: 'fin de vida' });

    const depot = await locations.findByCode('DEPOSITO');
    const asset = await assets.findById(assetId);
    expect(asset!.status).toBe('retired');
    expect(asset!.currentLocationId).toBe(depot!.id);
    const moves = await innerMovements.listByAsset(assetId);
    expect(moves[0].type).toBe('ADJUST');
    expect(moves[0].note).toBe('fin de vida');
  });

  // ── TECNICO without technicianId → error ────────────────────────────────────
  it('TECNICO without technicianId → TechnicianRequiredError (no item removed, no movement)', async () => {
    const { retire, inventory, assets, innerMovements, resolveClient } = await setup();
    const { itemId, assetId } = await seedItemWithAsset(inventory, resolveClient, assets);

    await expect(
      retire.execute({ contractId: CONTRACT_ID, itemId, disposition: 'TECNICO' }),
    ).rejects.toBeInstanceOf(TechnicianRequiredError);

    const item = await inventory.getById(itemId);
    expect(item!.status).toBe('active'); // NOT removed
    expect(await innerMovements.listByAsset(assetId)).toHaveLength(0);
  });

  // ── cross-contract → 404 ────────────────────────────────────────────────────
  it('item belongs to ANOTHER contract → InstalledItemNotFoundError (scoping)', async () => {
    const { retire, inventory, resolveClient, assets } = await setup();
    const { itemId } = await seedItemWithAsset(inventory, resolveClient, assets, {
      id: 'foreign',
      contractId: 'C2',
    });

    await expect(
      retire.execute({ contractId: CONTRACT_ID, itemId, disposition: 'DEPOSITO' }),
    ).rejects.toBeInstanceOf(InstalledItemNotFoundError);
  });

  it('unknown item → InstalledItemNotFoundError', async () => {
    const { retire } = await setup();
    await expect(
      retire.execute({ contractId: CONTRACT_ID, itemId: 'ghost', disposition: 'DEPOSITO' }),
    ).rejects.toBeInstanceOf(InstalledItemNotFoundError);
  });

  // ── already-removed → no-op (idempotent, no double movement) ────────────────
  it('already-removed item → returns the item, no re-routing (no second movement)', async () => {
    const { retire, inventory, assets, innerMovements, resolveClient } = await setup();
    const { itemId, assetId } = await seedItemWithAsset(inventory, resolveClient, assets, {
      status: 'removed',
    });

    const result = await retire.execute({ contractId: CONTRACT_ID, itemId, disposition: 'DEPOSITO' });

    expect(result.status).toBe('removed');
    // No movement was recorded — the asset is untouched.
    expect(await innerMovements.listByAsset(assetId)).toHaveLength(0);
    const asset = await assets.findById(assetId);
    expect(asset!.status).toBe('installed'); // unchanged
  });

  // ── legacy without asset → soft-delete only ─────────────────────────────────
  it('legacy item with assetId=null → only soft-deletes (no routing, no movement)', async () => {
    const { retire, inventory, innerMovements } = await setup();
    const item = await seedItem(inventory, { id: 'legacy', assetId: null, status: 'active' });

    const result = await retire.execute({
      contractId: CONTRACT_ID,
      itemId: item.id,
      disposition: 'DEPOSITO',
    });

    expect(result.status).toBe('removed');
    // No asset routing happened at all — the ledger is empty.
    expect(innerMovements.movements).toHaveLength(0);
  });

  // ── drifted asset (active CII, asset ≠ installed) → typed 409 + full rollback ─
  // The CII is `active` but its linked asset already drifted OUT of `installed`
  // (e.g. moved to `available` by another flow). Retiring must throw the typed
  // AssetNotInstalledError — NOT the cryptic InvalidStatusTransitionError — and the
  // UoW must roll back: the CII stays `active`, the asset stays untouched, no ledger.
  it('active CII but drifted (non-installed) asset → AssetNotInstalledError; rolls back', async () => {
    const { retire, inventory, assets, innerMovements, resolveClient } = await setup();
    const { itemId, assetId, clienteId } = await seedItemWithAsset(inventory, resolveClient, assets);
    // Drift the asset out of `installed` before the retire runs.
    await assets.updateStatus(assetId, 'available');

    await expect(
      retire.execute({ contractId: CONTRACT_ID, itemId, disposition: 'DEPOSITO' }),
    ).rejects.toBeInstanceOf(AssetNotInstalledError);

    // CII NOT removed — the b.inventory.remove() was rolled back.
    const item = await inventory.getById(itemId);
    expect(item!.status).toBe('active');
    // Asset unchanged — still available @ its CLIENTE location (no status/location flip).
    const asset = await assets.findById(assetId);
    expect(asset!.status).toBe('available');
    expect(asset!.currentLocationId).toBe(clienteId);
    // No ledger row.
    expect(await innerMovements.listByAsset(assetId)).toHaveLength(0);
  });

  // ── atomicity rollback ──────────────────────────────────────────────────────
  it('is atomic — a failing movement rolls back the CII removal AND the asset state', async () => {
    const { retire, inventory, assets, innerMovements, movements, resolveClient } = await setup();
    const { itemId, assetId, clienteId } = await seedItemWithAsset(inventory, resolveClient, assets);
    movements.failNext = true;

    await expect(
      retire.execute({ contractId: CONTRACT_ID, itemId, disposition: 'DEPOSITO' }),
    ).rejects.toThrow('INJECTED movement failure');

    // CII NOT removed.
    const item = await inventory.getById(itemId);
    expect(item!.status).toBe('active');
    // Asset unchanged — still installed @ CLIENTE.
    const asset = await assets.findById(assetId);
    expect(asset!.status).toBe('installed');
    expect(asset!.currentLocationId).toBe(clienteId);
    // No ledger row.
    expect(innerMovements.movements).toHaveLength(0);
  });
});

import { ConfirmAssetReturn } from '@application/use-cases/ConfirmAssetReturn';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { InMemoryReturnSuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryReturnSuggestionRepository';
import { InMemoryInventoryAssetRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryAssetRepository';
import { InMemoryInventoryMovementRepository } from '@infrastructure/adapters/in-memory/InMemoryInventoryMovementRepository';
import { InMemoryMaterialStockRepository } from '@infrastructure/adapters/in-memory/InMemoryMaterialStockRepository';
import { InMemoryStockLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryStockLocationRepository';
import { InMemoryDeviceTypeCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryDeviceTypeCatalogRepository';
import { InMemoryUnitOfWork } from '@infrastructure/adapters/in-memory/InMemoryUnitOfWork';
import { InMemoryInventorySuggestionRepository } from '@infrastructure/adapters/in-memory/InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from '@infrastructure/adapters/in-memory/InMemoryContractInventoryRepository';
import { createInventoryAsset, AssetStatus } from '@domain/entities/inventory-asset';
import { createReturnSuggestion, ReturnSuggestionStatus } from '@domain/entities/return-suggestion';
import { createInventoryMovement } from '@domain/entities/inventory-movement';
import {
  ReturnAlreadyResolvedError,
  ReturnHasNoAssetError,
  AssetNotReturnableError,
} from '@domain/errors/inventory';
import { randomUUID } from 'crypto';

const SO = 'so-900';

async function setup() {
  const returns = new InMemoryReturnSuggestionRepository();
  const assets = new InMemoryInventoryAssetRepository();
  const materials = new InMemoryMaterialStockRepository();
  const movements = new InMemoryInventoryMovementRepository(assets, materials);
  const locations = new InMemoryStockLocationRepository();
  const deviceTypes = new InMemoryDeviceTypeCatalogRepository();
  await deviceTypes.create({ name: 'OTROS', active: true, sortOrder: 0 });
  await deviceTypes.create({ name: 'ONU', active: true, sortOrder: 1 });

  const suggestions = new InMemoryInventorySuggestionRepository();
  const contractInv = new InMemoryContractInventoryRepository();
  const uow = new InMemoryUnitOfWork(suggestions, contractInv, locations, assets, movements, materials, returns);
  const resolveDepot = new ResolveDepotLocation(locations);

  const useCase = new ConfirmAssetReturn(returns, assets, movements, locations, deviceTypes, resolveDepot, uow);
  return { returns, assets, materials, movements, locations, deviceTypes, resolveDepot, useCase };
}

function seedAsset(assets: InMemoryInventoryAssetRepository, serial: string, status: AssetStatus = 'installed'): string {
  const id = `asset-${serial}-${randomUUID().slice(0, 4)}`;
  assets.store.set(id, createInventoryAsset({
    id, serialNumber: serial, deviceTypeId: 'dt-onu', status, currentLocationId: 'loc-client', source: 'OCR',
  }));
  return id;
}

async function stage(
  returns: InMemoryReturnSuggestionRepository,
  over: { serial?: string | null; matchedAssetId?: string | null; status?: ReturnSuggestionStatus } = {},
) {
  const s = createReturnSuggestion({
    id: randomUUID(),
    taskId: 't1',
    serviceOrderId: SO,
    serialNumber: over.serial === undefined ? 'SN001' : over.serial,
    matchedAssetId: over.matchedAssetId ?? null,
    status: over.status ?? 'pending',
  });
  await returns.create(s);
  return s;
}

describe('ConfirmAssetReturn', () => {
  it('(a) matched return → 1 RETURN movement, asset available@depot, suggestion confirmed', async () => {
    const { returns, assets, movements, locations, useCase } = await setup();
    const assetId = seedAsset(assets, 'SN001', 'installed');
    const s = await stage(returns, { serial: 'SN001', matchedAssetId: assetId, status: 'pending' });

    await useCase.execute({ suggestionId: s.id, resolution: 'return' });

    const depot = await locations.findByCode('DEPOSITO');
    expect(movements.movements).toHaveLength(1);
    expect(movements.movements[0].type).toBe('RETURN');
    expect(movements.movements[0].assetId).toBe(assetId);
    expect(movements.movements[0].toLocationId).toBe(depot!.id);
    expect(movements.movements[0].sourceRef).toBe(`iclass:return:${assetId}`); // Fix #3: asset-keyed
    const asset = await assets.findById(assetId);
    expect(asset!.status).toBe('available');
    expect(asset!.currentLocationId).toBe(depot!.id);
    const after = await returns.get(s.id);
    expect(after!.status).toBe('confirmed');
    expect(after!.resolution).toBe('return');
    expect(after!.confirmedMovementId).toBe(movements.movements[0].id); // Fix #5: the real uuid
    expect(after!.sourceRef).toBe(`iclass:return:${assetId}`);
  });

  it('(b) double-confirm → no second movement (sourceRef unique), idempotent', async () => {
    const { returns, assets, movements, useCase } = await setup();
    const assetId = seedAsset(assets, 'SN001', 'installed');
    const s = await stage(returns, { serial: 'SN001', matchedAssetId: assetId, status: 'pending' });

    await useCase.execute({ suggestionId: s.id, resolution: 'return' });
    // Re-confirm the SAME suggestion → already confirmed → rejected, no 2nd movement.
    await expect(useCase.execute({ suggestionId: s.id, resolution: 'return' })).rejects.toBeInstanceOf(
      ReturnAlreadyResolvedError,
    );
    expect(movements.movements).toHaveLength(1);
  });

  it('(c) link resolution → RETURN for the chosen asset', async () => {
    const { returns, assets, movements, locations, useCase } = await setup();
    const chosen = seedAsset(assets, 'ASSET-99', 'installed');
    const s = await stage(returns, { serial: 'SN-UNKNOWN', matchedAssetId: null, status: 'needs_review' });

    await useCase.execute({ suggestionId: s.id, resolution: 'link', linkedAssetId: chosen });

    const depot = await locations.findByCode('DEPOSITO');
    expect(movements.movements).toHaveLength(1);
    expect(movements.movements[0].assetId).toBe(chosen);
    const asset = await assets.findById(chosen);
    expect(asset!.status).toBe('available');
    expect(asset!.currentLocationId).toBe(depot!.id);
    const after = await returns.get(s.id);
    expect(after!.status).toBe('confirmed');
    expect(after!.resolution).toBe('link');
    expect(after!.matchedAssetId).toBe(chosen);
  });

  it('(d) create-at-depot → new asset available@depot, NO movement, suggestion confirmed', async () => {
    const { returns, assets, movements, locations, useCase } = await setup();
    const s = await stage(returns, { serial: 'SN-NEW', matchedAssetId: null, status: 'needs_review' });

    await useCase.execute({ suggestionId: s.id, resolution: 'create' });

    expect(movements.movements).toHaveLength(0); // create IS the depot entry, no movement
    const depot = await locations.findByCode('DEPOSITO');
    const created = await assets.findBySerialNumber('SN-NEW');
    expect(created).not.toBeNull();
    expect(created!.status).toBe('available');
    expect(created!.currentLocationId).toBe(depot!.id);
    const after = await returns.get(s.id);
    expect(after!.status).toBe('confirmed');
    expect(after!.resolution).toBe('create');
  });

  it('(e) discard → suggestion discarded, no movement', async () => {
    const { returns, movements, useCase } = await setup();
    const s = await stage(returns, { status: 'pending' });

    await useCase.execute({ suggestionId: s.id, resolution: 'discard' });

    expect(movements.movements).toHaveLength(0);
    const after = await returns.get(s.id);
    expect(after!.status).toBe('discarded');
    expect(after!.resolution).toBe('discard');
  });

  it('(f) atomic rollback: a movement failure leaves nothing persisted, suggestion stays pending', async () => {
    const { returns, assets, movements, useCase } = await setup();
    const assetId = seedAsset(assets, 'SN001', 'installed');
    const s = await stage(returns, { serial: 'SN001', matchedAssetId: assetId, status: 'pending' });

    // Force the ledger write to throw mid-transaction.
    jest.spyOn(movements, 'record').mockRejectedValueOnce(new Error('boom'));

    await expect(useCase.execute({ suggestionId: s.id, resolution: 'return' })).rejects.toThrow('boom');

    // Full rollback: asset still installed, suggestion still pending, no movement.
    const asset = await assets.findById(assetId);
    expect(asset!.status).toBe('installed');
    const after = await returns.get(s.id);
    expect(after!.status).toBe('pending');
    expect(movements.movements).toHaveLength(0);
  });

  it('rejects a link resolution with no chosen asset', async () => {
    const { returns, useCase } = await setup();
    const s = await stage(returns, { status: 'needs_review', matchedAssetId: null });
    await expect(useCase.execute({ suggestionId: s.id, resolution: 'link' })).rejects.toBeInstanceOf(
      ReturnHasNoAssetError,
    );
  });

  it('rejects confirming an already-discarded suggestion', async () => {
    const { returns, useCase } = await setup();
    const s = await stage(returns, { status: 'pending' });
    await useCase.execute({ suggestionId: s.id, resolution: 'discard' });
    await expect(useCase.execute({ suggestionId: s.id, resolution: 'discard' })).rejects.toBeInstanceOf(
      ReturnAlreadyResolvedError,
    );
  });

  // ── Fix #1 [HIGH]: installed precondition re-checked at confirm time ─────────
  it('(fix1-a) return of an asset no longer installed → AssetNotReturnableError, no movement, no change', async () => {
    const { returns, assets, movements, useCase } = await setup();
    // The asset moved/was returned between staging and confirm → now available.
    const assetId = seedAsset(assets, 'SN001', 'available');
    const s = await stage(returns, { serial: 'SN001', matchedAssetId: assetId, status: 'pending' });

    await expect(useCase.execute({ suggestionId: s.id, resolution: 'return' })).rejects.toBeInstanceOf(
      AssetNotReturnableError,
    );

    expect(movements.movements).toHaveLength(0);
    const asset = await assets.findById(assetId);
    expect(asset!.status).toBe('available'); // untouched
    const after = await returns.get(s.id);
    expect(after!.status).toBe('pending'); // suggestion stays open
  });

  it('(fix1-b) link to a NON-existent asset → AssetNotReturnableError, no movement', async () => {
    const { returns, movements, useCase } = await setup();
    const s = await stage(returns, { serial: 'SN-UNKNOWN', matchedAssetId: null, status: 'needs_review' });

    await expect(
      useCase.execute({ suggestionId: s.id, resolution: 'link', linkedAssetId: 'ghost-asset' }),
    ).rejects.toBeInstanceOf(AssetNotReturnableError);

    expect(movements.movements).toHaveLength(0);
  });

  it('(fix1-c) link to an AVAILABLE (not installed) asset → AssetNotReturnableError, no movement', async () => {
    const { returns, assets, movements, useCase } = await setup();
    const available = seedAsset(assets, 'AVAIL-1', 'available');
    const s = await stage(returns, { serial: 'SN-UNKNOWN', matchedAssetId: null, status: 'needs_review' });

    await expect(
      useCase.execute({ suggestionId: s.id, resolution: 'link', linkedAssetId: available }),
    ).rejects.toBeInstanceOf(AssetNotReturnableError);

    expect(movements.movements).toHaveLength(0);
    const asset = await assets.findById(available);
    expect(asset!.status).toBe('available'); // untouched
  });

  // ── Fix #3 [MEDIUM]: sourceRef keys on the ASSET, not (SO, serial) ──────────
  it('(fix3) two different suggestions returning the SAME asset → second is blocked (one movement)', async () => {
    const { returns, assets, movements, useCase } = await setup();
    const assetId = seedAsset(assets, 'SN001', 'installed');
    // Two suggestions, different serials/SOs, both linking to the SAME installed asset.
    const s1 = await stage(returns, { serial: 'SN001', matchedAssetId: assetId, status: 'pending' });
    const s2 = await stage(returns, { serial: 'SN001-DRIFT', matchedAssetId: null, status: 'needs_review' });

    await useCase.execute({ suggestionId: s1.id, resolution: 'return' });
    // s2 links to the same (now available) asset — Fix #1 blocks it (no longer installed),
    // which is the correct end-state: the asset can only be returned once.
    await expect(
      useCase.execute({ suggestionId: s2.id, resolution: 'link', linkedAssetId: assetId }),
    ).rejects.toBeInstanceOf(AssetNotReturnableError);

    expect(movements.movements).toHaveLength(1);
    expect(movements.movements[0].sourceRef).toBe(`iclass:return:${assetId}`);
  });

  // ── Fix #2 [HIGH]: L2 sourceRef idempotency BEFORE the write (no poisoned-tx recovery) ─
  it('(fix2) a movement with the asset sourceRef already exists → clean 409, NO second movement', async () => {
    const { returns, assets, movements, useCase } = await setup();
    const assetId = seedAsset(assets, 'SN001', 'installed');
    const s = await stage(returns, { serial: 'SN001', matchedAssetId: assetId, status: 'pending' });

    // Simulate a concurrent confirm that already wrote the RETURN movement for this asset
    // (bypassing the L1 status guard — the suggestion is still pending here). The pre-write
    // findBySourceRef MUST detect it and resolve idempotently to a clean 409, NOT a 2nd movement.
    movements.movements.push(
      createInventoryMovement({
        id: randomUUID(),
        type: 'RETURN',
        assetId,
        toLocationId: 'loc-depot',
        source: 'ICLASS_RETIRO',
        sourceRef: `iclass:return:${assetId}`,
      }),
    );

    await expect(useCase.execute({ suggestionId: s.id, resolution: 'return' })).rejects.toBeInstanceOf(
      ReturnAlreadyResolvedError,
    );

    // Exactly the one pre-existing movement — no duplicate RETURN appended.
    expect(movements.movements).toHaveLength(1);
  });

  // ── Fix #5 [LOW]: confirmedMovementId stores the movement id, sourceRef its own field ─
  it('(fix5) confirmedMovementId === the created movement id; sourceRef stored separately', async () => {
    const { returns, assets, movements, useCase } = await setup();
    const assetId = seedAsset(assets, 'SN001', 'installed');
    const s = await stage(returns, { serial: 'SN001', matchedAssetId: assetId, status: 'pending' });

    await useCase.execute({ suggestionId: s.id, resolution: 'return' });

    const mv = movements.movements[0];
    const after = await returns.get(s.id);
    expect(after!.confirmedMovementId).toBe(mv.id); // the real uuid, NOT the sourceRef string
    expect(after!.sourceRef).toBe(`iclass:return:${assetId}`);
  });
});

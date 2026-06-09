import { computeAssetEffect } from '@domain/entities/inventory-asset-effect';
import { createInventoryMovement } from '@domain/entities/inventory-movement';

/**
 * Fix #3 — single source of truth for the asset materialized-balance effect.
 * Both the Prisma and in-memory movement adapters must derive the asset's
 * post-state from THIS pure function (no independently-coded switches).
 */
describe('computeAssetEffect (Fix #3 — shared asset-effect)', () => {
  it('INSTALL → status installed + currentLocationId = toLocationId', () => {
    const mv = createInventoryMovement({ id: '1', type: 'INSTALL', assetId: 'A1', toLocationId: 'L_client', source: 'X' });
    expect(computeAssetEffect(mv)).toEqual({ currentLocationId: 'L_client', status: 'installed' });
  });

  it('RETURN → status available + currentLocationId = toLocationId (depot)', () => {
    const mv = createInventoryMovement({ id: '2', type: 'RETURN', assetId: 'A1', toLocationId: 'L_depot', source: 'X' });
    expect(computeAssetEffect(mv)).toEqual({ currentLocationId: 'L_depot', status: 'available' });
  });

  it('ISSUE on an asset is rejected by the factory (Fix M1 — ISSUE is a material verb)', () => {
    expect(() =>
      createInventoryMovement({ id: '3', type: 'ISSUE', assetId: 'A1', fromLocationId: 'L1', toLocationId: 'L2', source: 'X' }),
    ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
  });

  it('TRANSFER → only currentLocationId (when toLocationId present), no status', () => {
    const mv = createInventoryMovement({ id: '4', type: 'TRANSFER', assetId: 'A1', fromLocationId: 'L1', toLocationId: 'L2', source: 'X' });
    expect(computeAssetEffect(mv)).toEqual({ currentLocationId: 'L2' });
  });

  it('ADJUST → can set asset status from the movement', () => {
    const mv = createInventoryMovement({ id: '5', type: 'ADJUST', assetId: 'A1', status: 'damaged', note: 'broke', source: 'X' });
    expect(computeAssetEffect(mv)).toEqual({ status: 'damaged' });
  });

  it('ADJUST → can set both currentLocationId and status', () => {
    const mv = createInventoryMovement({ id: '6', type: 'ADJUST', assetId: 'A1', status: 'available', toLocationId: 'L_depot', note: 'relocate', source: 'X' });
    expect(computeAssetEffect(mv)).toEqual({ currentLocationId: 'L_depot', status: 'available' });
  });

  it('returns empty object when no effect applies (asset movement with no location/status)', () => {
    const mv = createInventoryMovement({ id: '7', type: 'ADJUST', assetId: 'A1', note: 'no-op audit', source: 'X' });
    expect(computeAssetEffect(mv)).toEqual({});
  });
});

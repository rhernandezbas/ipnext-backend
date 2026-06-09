import { createStockLocation } from '@domain/entities/stock-location';
import {
  createInventoryAsset,
  nextStatus,
  ASSET_STATUSES,
} from '@domain/entities/inventory-asset';
import { createMaterialStock, decrementStock, roundQty } from '@domain/entities/material-stock';
import { createInventoryMovement } from '@domain/entities/inventory-movement';

describe('StockLocation entity', () => {
  it('SL-deposito: DEPOSITO with no FKs is valid', () => {
    const loc = createStockLocation({ id: 'L1', type: 'DEPOSITO', code: 'DEPOSITO' });
    expect(loc.type).toBe('DEPOSITO');
    expect(loc.contractId).toBeNull();
    expect(loc.technicianId).toBeNull();
  });

  it('SL-cliente: CLIENTE with contractId is valid', () => {
    const loc = createStockLocation({ id: 'L2', type: 'CLIENTE', contractId: 'C1' });
    expect(loc.type).toBe('CLIENTE');
    expect(loc.contractId).toBe('C1');
    expect(loc.technicianId).toBeNull();
  });

  it('SL-tecnico: TECNICO with technicianId is valid', () => {
    const loc = createStockLocation({ id: 'L3', type: 'TECNICO', technicianId: 'U1' });
    expect(loc.type).toBe('TECNICO');
    expect(loc.technicianId).toBe('U1');
    expect(loc.contractId).toBeNull();
  });

  it('SL-invalid-type: unknown type rejected', () => {
    expect(() => createStockLocation({ id: 'L4', type: 'CAMIONETA' as never })).toThrow(
      expect.objectContaining({ code: 'INVALID_LOCATION_TYPE' }),
    );
  });

  it('SL-cliente-without-contractId: rejected', () => {
    expect(() => createStockLocation({ id: 'L5', type: 'CLIENTE', contractId: null })).toThrow(
      expect.objectContaining({ code: 'MISSING_LOCATION_FK' }),
    );
  });

  it('SL-tecnico-without-technicianId: rejected', () => {
    expect(() => createStockLocation({ id: 'L6', type: 'TECNICO', technicianId: null })).toThrow(
      expect.objectContaining({ code: 'MISSING_LOCATION_FK' }),
    );
  });
});

describe('InventoryAsset entity', () => {
  const base = {
    id: 'A1',
    serialNumber: 'SN001',
    deviceTypeId: 'router-id',
    currentLocationId: 'L1',
    source: 'MANUAL',
    status: 'available' as const,
  };

  it('IA-create: creates an asset with defaults', () => {
    const asset = createInventoryAsset(base);
    expect(asset.serialNumber).toBe('SN001');
    expect(asset.status).toBe('available');
    expect(asset.mac).toBeNull();
    expect(asset.sourceTaskId).toBeNull();
  });

  it('IA-create-at-depot-available: status=available, currentLocationId=depot', () => {
    const asset = createInventoryAsset({ ...base, currentLocationId: 'L1', status: 'available' });
    expect(asset.status).toBe('available');
    expect(asset.currentLocationId).toBe('L1');
  });

  it('IA-create-at-client-installed: status=installed at a CLIENTE location', () => {
    const asset = createInventoryAsset({
      id: 'A2', serialNumber: 'SN002', deviceTypeId: 'onu-id', currentLocationId: 'L2',
      source: 'ICLASS', status: 'installed',
    });
    expect(asset.status).toBe('installed');
    expect(asset.currentLocationId).toBe('L2');
  });

  it('IA-statuses: declares the 5 lifecycle statuses', () => {
    expect(ASSET_STATUSES).toEqual(
      expect.arrayContaining(['available', 'installed', 'removed', 'damaged', 'retired']),
    );
  });

  it('IA-valid-transition: available→installed', () => {
    expect(nextStatus('available', 'installed')).toBe('installed');
  });

  it('IA-valid-transition: installed→available', () => {
    expect(nextStatus('installed', 'available')).toBe('available');
  });

  it('IA-valid-transition: installed→removed', () => {
    expect(nextStatus('installed', 'removed')).toBe('removed');
  });

  it('IA-valid-transition: any→damaged', () => {
    expect(nextStatus('available', 'damaged')).toBe('damaged');
    expect(nextStatus('installed', 'retired')).toBe('retired');
  });

  it('IA-invalid-transition: available→removed rejected', () => {
    expect(() => nextStatus('available', 'removed')).toThrow(
      expect.objectContaining({ code: 'INVALID_STATUS_TRANSITION' }),
    );
  });
});

describe('MaterialStock entity', () => {
  it('MS-create: creates a stock row', () => {
    const ms = createMaterialStock({ id: 'S1', materialCatalogId: 'M1', locationId: 'L1', qty: 100 });
    expect(ms.qty).toBe(100);
  });

  it('MS-decrement-within-balance: 10 - 7 = 3', () => {
    expect(decrementStock('M1', 10, 7)).toBe(3);
  });

  it('MS-qty-zero-valid: 5 - 5 = 0', () => {
    expect(decrementStock('M1', 5, 5)).toBe(0);
  });

  it('MS-decrement-below-zero-rejected', () => {
    expect(() => decrementStock('M1', 5, 10)).toThrow(
      expect.objectContaining({ code: 'INSUFFICIENT_STOCK' }),
    );
  });

  it('MS-roundQty: snaps binary-float artifacts to Decimal(12,4) scale', () => {
    // The ONE rounding rule shared by the in-memory adapters and Prisma `dec()`.
    expect(roundQty(0.1 + 0.2)).toBe(0.3); // 0.30000000000000004 → 0.3
    expect(roundQty(100 - (0.1 + 0.2))).toBe(99.7);
    expect(roundQty(0.12345)).toBe(0.1235); // rounds half-up at the 4th decimal
    expect(roundQty(7)).toBe(7); // integers untouched
    expect(roundQty(0)).toBe(0);
  });

  it('MS-roundQty matches the Prisma dec() rounding (toFixed(4))', () => {
    // Same value the Decimal(12,4) column would store.
    for (const n of [0.1 + 0.2, 100 - (0.1 + 0.2), 0.12345, 1 / 3]) {
      expect(roundQty(n)).toBe(Number(n.toFixed(4)));
    }
  });
});

describe('InventoryMovement entity', () => {
  it('IML-asset-shape: asset-only movement is valid', () => {
    const mv = createInventoryMovement({
      id: 'MV1', type: 'INSTALL', assetId: 'A1', toLocationId: 'L2', source: 'ICLASS',
    });
    expect(mv.assetId).toBe('A1');
    expect(mv.materialCatalogId).toBeNull();
    expect(Object.isFrozen(mv)).toBe(true);
  });

  it('IML-material-shape: material+qty movement is valid', () => {
    const mv = createInventoryMovement({
      id: 'MV2', type: 'CONSUME', materialCatalogId: 'M1', qty: 5, fromLocationId: 'L1', source: 'ICLASS',
    });
    expect(mv.materialCatalogId).toBe('M1');
    expect(mv.qty).toBe(5);
  });

  it('IML-xor: both asset AND material rejected', () => {
    expect(() =>
      createInventoryMovement({
        id: 'MV3', type: 'INSTALL', assetId: 'A1', materialCatalogId: 'M1', qty: 1, source: 'X',
      }),
    ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
  });

  it('IML-xor: neither asset NOR material rejected', () => {
    expect(() =>
      createInventoryMovement({ id: 'MV4', type: 'ADJUST', source: 'X' }),
    ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
  });

  it('IML-qty-positive: material movement with qty<=0 rejected', () => {
    expect(() =>
      createInventoryMovement({ id: 'MV5', type: 'CONSUME', materialCatalogId: 'M1', qty: 0, source: 'X' }),
    ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
  });

  // ── Per-type required-field guards (Fix #4) ──────────────────────────────
  describe('IML per-type field guards', () => {
    it('INSTALL without toLocationId rejected', () => {
      expect(() =>
        createInventoryMovement({ id: 'G1', type: 'INSTALL', assetId: 'A1', source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('INSTALL with toLocationId accepted', () => {
      const mv = createInventoryMovement({ id: 'G1b', type: 'INSTALL', assetId: 'A1', toLocationId: 'L2', source: 'X' });
      expect(mv.type).toBe('INSTALL');
    });

    it('RETURN without toLocationId rejected', () => {
      expect(() =>
        createInventoryMovement({ id: 'G2', type: 'RETURN', assetId: 'A1', source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('CONSUME without fromLocationId rejected', () => {
      expect(() =>
        createInventoryMovement({ id: 'G3', type: 'CONSUME', materialCatalogId: 'M1', qty: 5, source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('ISSUE without fromLocationId rejected', () => {
      expect(() =>
        createInventoryMovement({ id: 'G4', type: 'ISSUE', materialCatalogId: 'M1', qty: 5, source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('TRANSFER without toLocationId rejected', () => {
      expect(() =>
        createInventoryMovement({ id: 'G5', type: 'TRANSFER', materialCatalogId: 'M1', qty: 5, fromLocationId: 'L1', source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('TRANSFER without fromLocationId rejected', () => {
      expect(() =>
        createInventoryMovement({ id: 'G6', type: 'TRANSFER', materialCatalogId: 'M1', qty: 5, toLocationId: 'L2', source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('TRANSFER with both locations accepted', () => {
      const mv = createInventoryMovement({ id: 'G6b', type: 'TRANSFER', materialCatalogId: 'M1', qty: 5, fromLocationId: 'L1', toLocationId: 'L2', source: 'X' });
      expect(mv.type).toBe('TRANSFER');
    });

    it('ADJUST without note rejected', () => {
      expect(() =>
        createInventoryMovement({ id: 'G7', type: 'ADJUST', materialCatalogId: 'M1', qty: 5, toLocationId: 'L1', source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('ADJUST with empty-string note rejected', () => {
      expect(() =>
        createInventoryMovement({ id: 'G7b', type: 'ADJUST', materialCatalogId: 'M1', qty: 5, toLocationId: 'L1', note: '   ', source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('ADJUST with note accepted', () => {
      const mv = createInventoryMovement({ id: 'G7c', type: 'ADJUST', materialCatalogId: 'M1', qty: 5, toLocationId: 'L1', note: 'count fix', source: 'X' });
      expect(mv.note).toBe('count fix');
    });

    it('ADJUST asset (no material) with note accepted — can set status', () => {
      const mv = createInventoryMovement({ id: 'G7d', type: 'ADJUST', assetId: 'A1', note: 'mark damaged', source: 'X' });
      expect(mv.assetId).toBe('A1');
    });

    // ── Fix H1 — material ADJUST requires a toLocationId target ──────────────
    it('material ADJUST without toLocationId rejected (would corrupt FK / phantom key)', () => {
      expect(() =>
        createInventoryMovement({ id: 'H1a', type: 'ADJUST', materialCatalogId: 'M1', qty: 5, note: 'count fix', source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('material ADJUST with toLocationId accepted', () => {
      const mv = createInventoryMovement({ id: 'H1b', type: 'ADJUST', materialCatalogId: 'M1', qty: 5, toLocationId: 'L1', note: 'count fix', source: 'X' });
      expect(mv.toLocationId).toBe('L1');
    });

    // ── Fix H2 — ADJUST is an absolute SET; a physical count of 0 is valid ───
    it('material ADJUST to qty=0 accepted (canonical zero-count correction)', () => {
      const mv = createInventoryMovement({ id: 'H2a', type: 'ADJUST', materialCatalogId: 'M1', qty: 0, toLocationId: 'L1', note: 'counted zero', source: 'X' });
      expect(mv.qty).toBe(0);
    });

    it('material ADJUST with negative qty still rejected', () => {
      expect(() =>
        createInventoryMovement({ id: 'H2b', type: 'ADJUST', materialCatalogId: 'M1', qty: -1, toLocationId: 'L1', note: 'bad', source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('non-ADJUST material movement with qty=0 still rejected (CONSUME)', () => {
      expect(() =>
        createInventoryMovement({ id: 'H2c', type: 'CONSUME', materialCatalogId: 'M1', qty: 0, fromLocationId: 'L1', source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    // ── Fix M1 — CONSUME/ISSUE must be material, never asset ─────────────────
    it('asset CONSUME rejected (assets leave via RETURN/removed, not CONSUME)', () => {
      expect(() =>
        createInventoryMovement({ id: 'M1a', type: 'CONSUME', assetId: 'A1', fromLocationId: 'L1', source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('asset ISSUE rejected', () => {
      expect(() =>
        createInventoryMovement({ id: 'M1b', type: 'ISSUE', assetId: 'A1', fromLocationId: 'L1', source: 'X' }),
      ).toThrow(expect.objectContaining({ code: 'INCONSISTENT_MOVEMENT' }));
    });

    it('INSTALL/RETURN/TRANSFER/ADJUST still valid for assets', () => {
      expect(createInventoryMovement({ id: 'M1c', type: 'INSTALL', assetId: 'A1', toLocationId: 'L2', source: 'X' }).type).toBe('INSTALL');
      expect(createInventoryMovement({ id: 'M1d', type: 'RETURN', assetId: 'A1', toLocationId: 'L1', source: 'X' }).type).toBe('RETURN');
      expect(createInventoryMovement({ id: 'M1e', type: 'TRANSFER', assetId: 'A1', fromLocationId: 'L1', toLocationId: 'L2', source: 'X' }).type).toBe('TRANSFER');
      expect(createInventoryMovement({ id: 'M1f', type: 'ADJUST', assetId: 'A1', note: 'mark damaged', source: 'X' }).type).toBe('ADJUST');
    });
  });
});

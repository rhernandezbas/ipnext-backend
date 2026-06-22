import { InventoryAsset, AssetStatus } from '@domain/entities/inventory-asset';

export interface InventoryAssetRepository {
  findById(id: string): Promise<InventoryAsset | null>;
  findBySerialNumber(serialNumber: string): Promise<InventoryAsset | null>;
  /**
   * Find any asset (any status/location) whose mac field matches exactly.
   * Used by the depot entry duplicate-check (409 guard). Returns null if not found.
   */
  findByMac(mac: string): Promise<InventoryAsset | null>;
  /**
   * Match an asset by NORMALIZED serial (trim/upper/strip non-alphanumerics — survives
   * IClass/OCR drift, #36 pattern) restricted to `status === 'installed'`. Returns null
   * when no installed asset matches. EPIC #38 W4 return staging: a non-installed match is
   * nonsensical (you cannot return an already-available/removed asset), so it is excluded
   * here → the staging use case treats it as `needs_review`. `findBySerialNumber` (exact,
   * any status) stays for #19.
   */
  findByNormalizedSerial(serial: string): Promise<InventoryAsset | null>;
  /**
   * Match any asset (ANY status/location) by NORMALIZED serial. Used by the depot entry
   * duplicate guard (FIX 2a): an asset with the same normalized serial cannot be added
   * again regardless of its current status — `SN-AAA-001`, `sn-aaa-001`, `SNAAA001` are
   * all the SAME device. Returns null if no asset matches.
   */
  findByNormalizedSerialAny(serial: string): Promise<InventoryAsset | null>;
  /**
   * All assets currently at a location, REGARDLESS of status. Generic on
   * purpose (W7 dashboard reuse) — status filtering lives in the use case.
   */
  listByLocation(locationId: string): Promise<InventoryAsset[]>;
  /** Enforces serialNumber uniqueness → DuplicateSerialNumberError. */
  create(asset: InventoryAsset): Promise<InventoryAsset>;
  updateLocation(id: string, locationId: string): Promise<InventoryAsset | null>;
  updateStatus(id: string, status: AssetStatus): Promise<InventoryAsset | null>;
  /**
   * Set the asset's `mac`. Used by the enrich/revive path (Cambio A) to backfill a
   * MAC onto an existing asset that had none — so a PPPoE add that matches an
   * SN-only asset records the MAC without creating a duplicate. Returns the updated
   * asset, or null if not found. Honors the same mac partial-unique as `create`.
   */
  updateMac(id: string, mac: string): Promise<InventoryAsset | null>;
}

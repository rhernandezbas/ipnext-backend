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
   * All assets currently at a location, REGARDLESS of status. Generic on
   * purpose (W7 dashboard reuse) — status filtering lives in the use case.
   */
  listByLocation(locationId: string): Promise<InventoryAsset[]>;
  /** Enforces serialNumber uniqueness → DuplicateSerialNumberError. */
  create(asset: InventoryAsset): Promise<InventoryAsset>;
  updateLocation(id: string, locationId: string): Promise<InventoryAsset | null>;
  updateStatus(id: string, status: AssetStatus): Promise<InventoryAsset | null>;
}

import { InventoryAsset, AssetStatus } from '@domain/entities/inventory-asset';

export interface InventoryAssetRepository {
  findById(id: string): Promise<InventoryAsset | null>;
  findBySerialNumber(serialNumber: string): Promise<InventoryAsset | null>;
  /** Enforces serialNumber uniqueness → DuplicateSerialNumberError. */
  create(asset: InventoryAsset): Promise<InventoryAsset>;
  updateLocation(id: string, locationId: string): Promise<InventoryAsset | null>;
  updateStatus(id: string, status: AssetStatus): Promise<InventoryAsset | null>;
}

import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryAsset, AssetStatus } from '@domain/entities/inventory-asset';
import { DuplicateSerialNumberError } from '@domain/errors/inventory';

export class InMemoryInventoryAssetRepository implements InventoryAssetRepository {
  readonly store = new Map<string, InventoryAsset>();

  async findById(id: string): Promise<InventoryAsset | null> {
    const a = this.store.get(id);
    return a ? { ...a } : null;
  }

  async findBySerialNumber(serialNumber: string): Promise<InventoryAsset | null> {
    const a = Array.from(this.store.values()).find((x) => x.serialNumber === serialNumber);
    return a ? { ...a } : null;
  }

  async listByLocation(locationId: string): Promise<InventoryAsset[]> {
    // Generic: ALL assets at the location regardless of status (W7 reuse).
    // The use case applies any status filter.
    return Array.from(this.store.values())
      .filter((a) => a.currentLocationId === locationId)
      .map((a) => ({ ...a }));
  }

  async create(asset: InventoryAsset): Promise<InventoryAsset> {
    const dup = Array.from(this.store.values()).some(
      (x) => x.serialNumber === asset.serialNumber,
    );
    if (dup) throw new DuplicateSerialNumberError(asset.serialNumber);
    this.store.set(asset.id, { ...asset });
    return { ...asset };
  }

  async updateLocation(id: string, locationId: string): Promise<InventoryAsset | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, currentLocationId: locationId };
    this.store.set(id, updated);
    return { ...updated };
  }

  async updateStatus(id: string, status: AssetStatus): Promise<InventoryAsset | null> {
    const existing = this.store.get(id);
    if (!existing) return null;
    const updated = { ...existing, status };
    this.store.set(id, updated);
    return { ...updated };
  }
}

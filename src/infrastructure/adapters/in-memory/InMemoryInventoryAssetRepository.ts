import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryAsset, AssetStatus } from '@domain/entities/inventory-asset';
import { DuplicateSerialNumberError } from '@domain/errors/inventory';
import { normalizeSerial } from '@domain/entities/return-suggestion';

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

  async findByMac(mac: string): Promise<InventoryAsset | null> {
    const a = Array.from(this.store.values()).find((x) => x.mac === mac);
    return a ? { ...a } : null;
  }

  async findByNormalizedSerial(serial: string): Promise<InventoryAsset | null> {
    const target = normalizeSerial(serial);
    if (target == null) return null;
    const a = Array.from(this.store.values()).find(
      (x) => x.status === 'installed' && normalizeSerial(x.serialNumber) === target,
    );
    return a ? { ...a } : null;
  }

  async findByNormalizedSerialAny(serial: string): Promise<InventoryAsset | null> {
    const target = normalizeSerial(serial);
    if (target == null) return null;
    // Any status/location — used by depot entry duplicate guard (FIX 2a).
    const a = Array.from(this.store.values()).find(
      (x) => normalizeSerial(x.serialNumber) === target,
    );
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
    const dupSerial = Array.from(this.store.values()).some(
      (x) => x.serialNumber === asset.serialNumber,
    );
    if (dupSerial) throw new DuplicateSerialNumberError(asset.serialNumber);

    // FIX 3: mac partial unique mirror — NULLs are free; non-null macs must be unique.
    // Throws a P2002-shaped error so the route handler maps it to 409 ASSET_ALREADY_EXISTS
    // (same signal as the DB partial unique index on InventoryAsset.mac WHERE mac IS NOT NULL).
    if (asset.mac != null) {
      const dupMac = Array.from(this.store.values()).some(
        (x) => x.mac != null && x.mac === asset.mac,
      );
      if (dupMac) {
        const err = Object.assign(
          new Error(`Unique constraint failed on the fields: (\`mac\`)`),
          { code: 'P2002', meta: { target: ['mac'] } },
        );
        throw err;
      }
    }

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

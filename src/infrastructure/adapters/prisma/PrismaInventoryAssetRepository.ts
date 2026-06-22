import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryAsset, AssetStatus } from '@domain/entities/inventory-asset';
import { DuplicateSerialNumberError } from '@domain/errors/inventory';
import { normalizeSerial, canonicalizeMac } from '@domain/entities/return-suggestion';
import { prisma } from '../../database/prisma';
import { PrismaClientLike } from './PrismaClientLike';

type Row = {
  id: string;
  serialNumber: string;
  mac: string | null;
  deviceTypeId: string;
  status: string;
  currentLocationId: string;
  source: string;
  sourceTaskId: string | null;
};

function toEntity(r: Row): InventoryAsset {
  return {
    id: r.id,
    serialNumber: r.serialNumber,
    mac: r.mac,
    deviceTypeId: r.deviceTypeId,
    status: r.status as AssetStatus,
    currentLocationId: r.currentLocationId,
    source: r.source,
    sourceTaskId: r.sourceTaskId,
  };
}

export class PrismaInventoryAssetRepository implements InventoryAssetRepository {
  constructor(private readonly db: PrismaClientLike = prisma) {}

  async findById(id: string): Promise<InventoryAsset | null> {
    const row = await this.db.inventoryAsset.findUnique({ where: { id } });
    return row ? toEntity(row) : null;
  }

  async findBySerialNumber(serialNumber: string): Promise<InventoryAsset | null> {
    const row = await this.db.inventoryAsset.findUnique({ where: { serialNumber } });
    return row ? toEntity(row) : null;
  }

  async findByMac(mac: string): Promise<InventoryAsset | null> {
    // W2: normalize arg before the exact DB query — new rows are stored canonical so
    // 'AA:BB:CC:DD:EE:FF' hits the exact match. For legacy non-canonical rows, fall
    // back to in-process scan (same pattern as findByNormalizedSerialAny drift path).
    const canonical = canonicalizeMac(mac);
    if (canonical == null) return null;
    const exact = await this.db.inventoryAsset.findFirst({ where: { mac: canonical } });
    if (exact) return toEntity(exact as Row);
    // Drift fallback: scan and normalize-compare (legacy rows stored without canonical form).
    const rows = (await this.db.inventoryAsset.findMany({ where: { mac: { not: null } } })) as Row[];
    const match = rows.find((r) => r.mac != null && canonicalizeMac(r.mac) === canonical);
    return match ? toEntity(match) : null;
  }

  async findByNormalizedSerial(serial: string): Promise<InventoryAsset | null> {
    const target = normalizeSerial(serial);
    if (target == null) return null;
    // Fast path: an exact (already-clean) serial hits the UNIQUE index directly.
    const exact = await this.db.inventoryAsset.findUnique({ where: { serialNumber: serial } });
    if (exact && (exact as Row).status === 'installed' && normalizeSerial((exact as Row).serialNumber) === target) {
      return toEntity(exact);
    }
    // Drift path: no DB-side normalized column, so scan installed assets and
    // normalize-compare in-process. W4 return volume is low (one per closed retiro),
    // so this is acceptable; revisit with a stored normalized column if it grows.
    const rows = (await this.db.inventoryAsset.findMany({ where: { status: 'installed' } })) as Row[];
    const match = rows.find((r) => normalizeSerial(r.serialNumber) === target);
    return match ? toEntity(match) : null;
  }

  async findByNormalizedSerialAny(serial: string): Promise<InventoryAsset | null> {
    const target = normalizeSerial(serial);
    if (target == null) return null;
    // Depot entry duplicate guard (FIX 2a): any status/location.
    // Fast path: try exact hit on the UNIQUE index first.
    const exact = await this.db.inventoryAsset.findUnique({ where: { serialNumber: serial } });
    if (exact && normalizeSerial((exact as Row).serialNumber) === target) {
      return toEntity(exact);
    }
    // Drift path: scan all assets and normalize-compare in-process.
    // Depot entry volume is low (manual operator action), so this is acceptable.
    const rows = (await this.db.inventoryAsset.findMany({})) as Row[];
    const match = rows.find((r) => normalizeSerial(r.serialNumber) === target);
    return match ? toEntity(match) : null;
  }

  async listByLocation(locationId: string): Promise<InventoryAsset[]> {
    // Generic: ALL assets at the location regardless of status (W7 dashboard
    // reuse). Status filtering lives in the use case, NOT here.
    const rows = await this.db.inventoryAsset.findMany({ where: { currentLocationId: locationId } });
    return (rows as Row[]).map(toEntity);
  }

  async create(asset: InventoryAsset): Promise<InventoryAsset> {
    try {
      const row = await this.db.inventoryAsset.create({
        data: {
          id: asset.id,
          serialNumber: asset.serialNumber,
          mac: asset.mac,
          deviceTypeId: asset.deviceTypeId,
          status: asset.status,
          currentLocationId: asset.currentLocationId,
          source: asset.source,
          sourceTaskId: asset.sourceTaskId,
        },
      });
      return toEntity(row);
    } catch (e) {
      // Prisma P2002 = unique constraint failed (serialNumber)
      if (e && typeof e === 'object' && (e as { code?: string }).code === 'P2002') {
        throw new DuplicateSerialNumberError(asset.serialNumber);
      }
      throw e;
    }
  }

  async updateLocation(id: string, locationId: string): Promise<InventoryAsset | null> {
    const existing = await this.db.inventoryAsset.findUnique({ where: { id } });
    if (!existing) return null;
    const row = await this.db.inventoryAsset.update({
      where: { id },
      data: { currentLocationId: locationId },
    });
    return toEntity(row);
  }

  async updateStatus(id: string, status: AssetStatus): Promise<InventoryAsset | null> {
    const existing = await this.db.inventoryAsset.findUnique({ where: { id } });
    if (!existing) return null;
    const row = await this.db.inventoryAsset.update({ where: { id }, data: { status } });
    return toEntity(row);
  }

  async updateMac(id: string, mac: string): Promise<InventoryAsset | null> {
    const existing = await this.db.inventoryAsset.findUnique({ where: { id } });
    if (!existing) return null;
    // Store the canonical MAC form (mirrors the canonical-storage requirement the
    // mac partial-unique relies on). A collision surfaces as P2002 from the DB.
    const canonical = canonicalizeMac(mac) ?? mac;
    const row = await this.db.inventoryAsset.update({
      where: { id },
      data: { mac: canonical },
    });
    return toEntity(row);
  }
}

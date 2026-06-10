import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryAsset, AssetStatus } from '@domain/entities/inventory-asset';
import { DuplicateSerialNumberError } from '@domain/errors/inventory';
import { normalizeSerial } from '@domain/entities/return-suggestion';
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
    const row = await this.db.inventoryAsset.findFirst({ where: { mac } });
    return row ? toEntity(row as Row) : null;
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
}

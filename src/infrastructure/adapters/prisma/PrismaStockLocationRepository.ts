import { StockLocationRepository, LocationContent, LocationLabel } from '@domain/ports/StockLocationRepository';
import { StockLocation, StockLocationType } from '@domain/entities/stock-location';
import { prisma } from '../../database/prisma';
import { PrismaClientLike } from './PrismaClientLike';

type Row = {
  id: string;
  type: string;
  code: string | null;
  contractId: string | null;
  technicianId: string | null;
  vehicleId: string | null;
};

function toEntity(r: Row): StockLocation {
  return {
    id: r.id,
    type: r.type as StockLocationType,
    code: r.code,
    contractId: r.contractId,
    technicianId: r.technicianId,
    vehicleId: (r as any).vehicleId ?? null,
  };
}

export class PrismaStockLocationRepository implements StockLocationRepository {
  constructor(private readonly db: PrismaClientLike = prisma) {}

  async findByCode(code: string): Promise<StockLocation | null> {
    const row = await this.db.stockLocation.findUnique({ where: { code } });
    return row ? toEntity(row) : null;
  }

  async findByTypeAndContract(type: string, contractId: string): Promise<StockLocation | null> {
    const row = await this.db.stockLocation.findUnique({
      where: { type_contractId: { type, contractId } },
    });
    return row ? toEntity(row) : null;
  }

  async findByTypeAndTechnician(type: string, technicianId: string): Promise<StockLocation | null> {
    const row = await this.db.stockLocation.findUnique({
      where: { type_technicianId: { type, technicianId } },
    });
    return row ? toEntity(row) : null;
  }

  /** One CAMIONETA per vehicle — uses the compound unique (type, vehicleId). */
  async findByTypeAndVehicle(type: StockLocationType, vehicleId: string): Promise<StockLocation | null> {
    const row = await (this.db.stockLocation as any).findUnique({
      where: { type_vehicleId: { type, vehicleId } },
    });
    return row ? toEntity(row) : null;
  }

  async create(location: StockLocation): Promise<StockLocation> {
    const row = await this.db.stockLocation.create({
      data: {
        id: location.id,
        type: location.type,
        code: location.code,
        contractId: location.contractId,
        technicianId: location.technicianId,
        vehicleId: location.vehicleId ?? null,
      },
    });
    return toEntity(row);
  }

  /**
   * Wave 7 (Capstone) — ONE Prisma pass: finds all locations with assetCount > 0
   * OR materialQty > 0. Labels resolved via selective include (contract.client,
   * technician, vehicle) — no per-row N+1.
   */
  async listWithContent(): Promise<LocationContent[]> {
    // FIX-4: count ALL assets at each location (no status filter). An installed asset
    // parked at a CLIENTE location counts as "being there" — filtering by status:'available'
    // would zero out CLIENTE locations that hold only installed assets (the BULK of prod data).
    const [assetCounts, materialQtys] = await Promise.all([
      (this.db as any).inventoryAsset.groupBy({
        by: ['currentLocationId'],
        _count: { id: true },
      }),
      (this.db as any).materialStock.groupBy({
        by: ['locationId'],
        _sum: { qty: true },
      }),
    ]);

    // Build maps: locationId → counts
    const assetMap = new Map<string, number>();
    for (const row of assetCounts) {
      if (row.currentLocationId) assetMap.set(row.currentLocationId, row._count.id);
    }
    const materialMap = new Map<string, number>();
    for (const row of materialQtys) {
      const qty = typeof row._sum.qty === 'object' && row._sum.qty !== null
        ? Number(row._sum.qty)
        : Number(row._sum.qty ?? 0);
      if (row.locationId && qty > 0) materialMap.set(row.locationId, qty);
    }

    // Collect all location ids with content
    const locationIds = new Set([...assetMap.keys(), ...materialMap.keys()]);
    if (locationIds.size === 0) return [];

    // Fetch locations with label-related includes in ONE query
    const locations = await (this.db as any).stockLocation.findMany({
      where: { id: { in: [...locationIds] } },
      include: {
        contract: { include: { client: { select: { name: true } } } },
        technician: { select: { id: true, name: true } },
        vehicle: { select: { id: true, plate: true } },
      },
    });

    return locations.map((loc: any): LocationContent => {
      let label: string | null = null;
      if (loc.type === 'DEPOSITO') {
        label = 'Depósito';
      } else if (loc.type === 'CLIENTE' && loc.contract?.client) {
        label = loc.contract.client.name;
      } else if (loc.type === 'TECNICO' && loc.technician) {
        label = loc.technician.name;
      } else if (loc.type === 'CAMIONETA' && loc.vehicle) {
        label = loc.vehicle.plate;
      }

      return {
        id: loc.id,
        type: loc.type as StockLocationType,
        code: loc.code ?? null,
        contractId: loc.contractId ?? null,
        technicianId: loc.technicianId ?? null,
        vehicleId: loc.vehicleId ?? null,
        label,
        assetCount: assetMap.get(loc.id) ?? 0,
        materialQty: materialMap.get(loc.id) ?? 0,
      };
    });
  }

  /**
   * FIX-3 (Wave 7 review) — batch-resolve labels for ANY location ids, including
   * now-empty locations that listWithContent() omits. ONE Prisma pass with selective
   * include (contract.client, technician, vehicle) — no N+1. Used by ListInventoryMovements.
   */
  async findLabelsByIds(ids: string[]): Promise<LocationLabel[]> {
    if (ids.length === 0) return [];

    const locations = await (this.db as any).stockLocation.findMany({
      where: { id: { in: ids } },
      include: {
        contract: { include: { client: { select: { name: true } } } },
        technician: { select: { id: true, name: true } },
        vehicle: { select: { id: true, plate: true } },
      },
    });

    return locations.map((loc: any): LocationLabel => {
      let label: string | null = null;
      if (loc.type === 'DEPOSITO') {
        label = 'Depósito';
      } else if (loc.type === 'CLIENTE' && loc.contract?.client) {
        label = loc.contract.client.name;
      } else if (loc.type === 'TECNICO' && loc.technician) {
        label = loc.technician.name;
      } else if (loc.type === 'CAMIONETA' && loc.vehicle) {
        label = loc.vehicle.plate;
      }
      return { id: loc.id, type: loc.type as StockLocationType, label };
    });
  }
}

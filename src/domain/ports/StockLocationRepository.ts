import { StockLocation, StockLocationType } from '@domain/entities/stock-location';

/**
 * Wave 7 (Capstone) — one row per StockLocation with content (assetCount > 0 OR materialQty > 0).
 * Labels are resolved in the adapter (no N+1): client name, technician name, vehicle plate, or 'Depósito'.
 */
export interface LocationContent {
  id: string;
  type: StockLocationType;
  code: string | null;
  contractId: string | null;
  technicianId: string | null;
  vehicleId: string | null;
  /** Resolved human label: client name | technician name | vehicle plate | 'Depósito'. */
  label: string | null;
  /** Count of available assets at this location. */
  assetCount: number;
  /** SUM(MaterialStock.qty) at this location. */
  materialQty: number;
}

/**
 * FIX-3 (Wave 7 review) — resolved label for any location, regardless of content.
 * Used by ListInventoryMovements to resolve from/to labels for movements referencing
 * now-empty locations (which listWithContent() omits).
 */
export interface LocationLabel {
  id: string;
  type: StockLocationType;
  /** Resolved human label: same rules as LocationContent.label. null if unresolvable. */
  label: string | null;
}

export interface StockLocationRepository {
  /** DEPOSITO singleton lookup by stable code. */
  findByCode(code: string): Promise<StockLocation | null>;
  /** One CLIENTE per contract. */
  findByTypeAndContract(type: string, contractId: string): Promise<StockLocation | null>;
  /** One TECNICO per technician. */
  findByTypeAndTechnician(type: string, technicianId: string): Promise<StockLocation | null>;
  /** One CAMIONETA per vehicle (EPIC #38 W5b). */
  findByTypeAndVehicle(type: StockLocationType, vehicleId: string): Promise<StockLocation | null>;
  create(location: StockLocation): Promise<StockLocation>;
  /**
   * Wave 7 (Capstone) — returns all locations that have at least one asset OR materialQty > 0.
   * Labels are resolved in ONE Prisma pass (selective include) — no N+1.
   */
  listWithContent(): Promise<LocationContent[]>;
  /**
   * FIX-3 (Wave 7 review) — batch-resolve labels for ANY location ids, including
   * now-empty locations that listWithContent() omits. One Prisma pass (selective include),
   * no N+1. Used by ListInventoryMovements to label from/to location fields.
   */
  findLabelsByIds(ids: string[]): Promise<LocationLabel[]>;
}

import { StockLocationType } from '@domain/entities/stock-location';

/**
 * Wave 7 (Capstone) — wire contract for GET /api/inventory/overview/locations.
 * ALL 4 types always present in the response (empty types have count 0).
 * FE is built against this exact shape — do NOT change field names.
 */

export interface OverviewLocationDTO {
  locationId: string;
  label: string | null;
  assetCount: number;
  materialQty: number;
}

export interface OverviewGroupDTO {
  type: StockLocationType;
  locationCount: number;
  totalAssets: number;
  totalMaterialQty: number;
  locations: OverviewLocationDTO[];
}

export interface InventoryOverviewDTO {
  groups: OverviewGroupDTO[];
}

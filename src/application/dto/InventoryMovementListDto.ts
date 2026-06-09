import { MovementType } from '@domain/entities/inventory-movement';

/**
 * Wave 7 (Capstone) — wire contract for GET /api/inventory/movements.
 * FE is built against this exact shape — do NOT change field names.
 */

export interface MovementRowDTO {
  id: string;
  type: MovementType;
  occurredAt: string;
  assetId: string | null;
  materialCatalogId: string | null;
  materialName: string | null;
  qty: number | null;
  fromLocationId: string | null;
  fromLocationLabel: string | null;
  toLocationId: string | null;
  toLocationLabel: string | null;
  taskId: string | null;
  taskSeq: number | null;
  technicianId: string | null;
  technicianName: string | null;
  source: string;
  note: string | null;
}

export interface InventoryMovementListDTO {
  items: MovementRowDTO[];
  total: number;
  page: number;
  limit: number;
}

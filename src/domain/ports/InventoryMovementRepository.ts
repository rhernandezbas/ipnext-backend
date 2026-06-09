import { InventoryMovement, MovementType } from '@domain/entities/inventory-movement';
import { AssetStatus } from '@domain/entities/inventory-asset';

/** Port shape per design D2 — the atomic ledger-write entry point. */
export interface RecordMovementInput {
  type: MovementType;
  assetId?: string;
  materialCatalogId?: string;
  qty?: number;
  fromLocationId?: string;
  toLocationId?: string;
  taskId?: string;
  technicianId?: string;
  source: string;
  note?: string;
  occurredAt?: string;
  /** Only honored for ADJUST on an asset — lets an ADJUST set the asset status. */
  status?: AssetStatus;
}

export interface InventoryMovementRepository {
  /**
   * Atomic: persists the ledger row AND updates the materialized balance
   * (asset.currentLocationId/status for serialized, MaterialStock.qty for consumable)
   * in one all-or-nothing operation. Throws before any write on guard failure.
   */
  record(input: RecordMovementInput): Promise<InventoryMovement>;
  /** Read helper for tests/queries — movements for an asset. */
  listByAsset(assetId: string): Promise<InventoryMovement[]>;
}

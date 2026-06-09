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
  /**
   * Optional L2 idempotency natural key (EPIC #38 W4 returns). When set, the adapter
   * persists it; a re-insert hitting the PARTIAL UNIQUE on sourceRef is caught (P2002)
   * and resolved to the EXISTING movement — an idempotent no-op double-confirm guard.
   */
  sourceRef?: string;
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
  /**
   * L2 idempotency lookup (EPIC #38 W4, Fix #2). Returns the movement already stamped
   * with this natural key, or null. The confirm use case checks this BEFORE the RETURN
   * write so a concurrent/double confirm resolves to a clean idempotent reject — never
   * relying on the post-abort recovery inside a poisoned transaction.
   */
  findBySourceRef(sourceRef: string): Promise<InventoryMovement | null>;
}

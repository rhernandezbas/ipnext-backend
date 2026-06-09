/** Dynamic — validated against the DeviceType catalog at runtime (not a closed union). */
export type InstalledItemType = string;
export type InstalledItemStatus = 'active' | 'removed' | 'replaced';

/**
 * Confirmed inventory on the client's contract. ONE row = ONE
 * physical device — 2 routers = 2 rows. `serialNumber`/`mac` are SINGULAR.
 */
export interface ContractInstalledItem {
  id: string;
  contractId: string;
  type: InstalledItemType;
  serialNumber: string | null;
  mac: string | null;
  model: string | null;
  /** OCR | MANUAL | ICLASS — how it got here. */
  source: string;
  /** Task that installed it (null for purely manual adds). */
  sourceTaskId: string | null;
  addedByUserId: string | null;
  confirmedAt: string | null;
  status: InstalledItemStatus;
  notes: string | null;
  /** Id of the item this one replaced (self-relation). null for items that didn't replace anything. */
  replacesItemId: string | null;
  /** Inventory Foundation (W1): link to the unified InventoryAsset ledger record. null = not yet migrated. */
  assetId: string | null;
  createdAt: string;
  updatedAt: string;
}

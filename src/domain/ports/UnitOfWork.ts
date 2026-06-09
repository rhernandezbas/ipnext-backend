import { InventorySuggestionRepository } from './InventorySuggestionRepository';
import { ContractInventoryRepository } from './ContractInventoryRepository';
import { StockLocationRepository } from './StockLocationRepository';
import { InventoryAssetRepository } from './InventoryAssetRepository';
import { InventoryMovementRepository } from './InventoryMovementRepository';
import { ReturnSuggestionRepository } from './ReturnSuggestionRepository';

/**
 * Tx-scoped repository bag handed to a `runInTransaction` callback. Every write
 * issued through these repos shares the SAME transaction, so the whole confirm/
 * replace dual-write (asset + INSTALL movement + CII + setStatus) is all-or-nothing.
 *
 * Fix #1 (design D2): ConfirmInventorySuggestion previously did asset.create() →
 * movements.record() → inventory.create() → setStatus() as SEPARATE transactions.
 * A mid-sequence failure orphaned an asset (no CII) or an asset without its
 * movement; a retry double-counted the INSTALL. Wrapping all four writes in one
 * `runInTransaction` makes a partial failure roll back cleanly.
 */
export interface TransactionalRepos {
  suggestions: InventorySuggestionRepository;
  inventory: ContractInventoryRepository;
  locations: StockLocationRepository;
  assets: InventoryAssetRepository;
  movements: InventoryMovementRepository;
  /**
   * EPIC #38 W4 — tx-scoped ReturnSuggestion repo. Optional: legacy #19 confirm/replace
   * call sites do not need it. Present when the UnitOfWork is wired for the W4 return
   * confirm, so the RETURN movement + asset flip + suggestion stamp commit atomically.
   */
  returns?: ReturnSuggestionRepository;
}

/**
 * Transaction-runner PORT. The Prisma adapter opens `prisma.$transaction(async tx
 * => …)` and exposes tx-scoped repos so all writes share the tx; the in-memory
 * adapter snapshots its stores and ROLLS BACK on throw (true all-or-nothing for
 * tests). No compensation/try-catch-delete hacks — a real transaction boundary.
 */
export interface UnitOfWork {
  runInTransaction<T>(fn: (repos: TransactionalRepos) => Promise<T>): Promise<T>;
}

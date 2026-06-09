import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';
import { InventoryMovementRepository } from '@domain/ports/InventoryMovementRepository';
import { InventoryMovement } from '@domain/entities/inventory-movement';
import { InMemoryInventorySuggestionRepository } from './InMemoryInventorySuggestionRepository';
import { InMemoryContractInventoryRepository } from './InMemoryContractInventoryRepository';
import { InMemoryStockLocationRepository } from './InMemoryStockLocationRepository';
import { InMemoryInventoryAssetRepository } from './InMemoryInventoryAssetRepository';
import { InMemoryMaterialStockRepository } from './InMemoryMaterialStockRepository';
import { InMemoryReturnSuggestionRepository } from './InMemoryReturnSuggestionRepository';

/**
 * The in-memory UoW only needs the movement repo's backing `movements` array to
 * snapshot/rollback. Both InMemoryInventoryMovementRepository and a test
 * decorator wrapping it satisfy this shape.
 */
type SnapshotableMovementRepo = InventoryMovementRepository & {
  readonly movements: InventoryMovement[];
};

/**
 * In-memory UnitOfWork (Fix #1/#3). Hands the SAME repo instances to the
 * callback so mutations land on the shared stores, but snapshots every backing
 * store BEFORE the callback runs and ROLLS BACK (restores the snapshot) if the
 * callback throws. This is a true all-or-nothing boundary — no compensation
 * logic — so tests can assert "nothing persisted on partial failure".
 *
 * The asset/movement/material-stock stores are entangled (a movement mutates the
 * asset + stock), so all of them are captured together; restoring all on throw
 * keeps the materialized balances consistent with the ledger.
 */
export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(
    private readonly suggestions: InMemoryInventorySuggestionRepository,
    private readonly inventory: InMemoryContractInventoryRepository,
    private readonly locations: InMemoryStockLocationRepository,
    private readonly assets: InMemoryInventoryAssetRepository,
    private readonly movements: SnapshotableMovementRepo,
    private readonly materialStock: InMemoryMaterialStockRepository,
    // EPIC #38 W4 — optional ReturnSuggestion repo. When present its store is
    // snapshotted/rolled back with the rest, so the W4 confirm (RETURN movement +
    // asset flip + suggestion stamp) is truly all-or-nothing in tests.
    private readonly returns?: InMemoryReturnSuggestionRepository,
  ) {}

  async runInTransaction<T>(fn: (repos: TransactionalRepos) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot();
    try {
      return await fn({
        suggestions: this.suggestions,
        inventory: this.inventory,
        locations: this.locations,
        assets: this.assets,
        movements: this.movements,
        returns: this.returns,
      });
    } catch (err) {
      this.restore(snapshot);
      throw err;
    }
  }

  /**
   * INVARIANT (Fix W-DimA): this is a SHALLOW Map copy — it captures the
   * entry→object references, NOT deep clones. It is correct ONLY because every
   * in-memory repo REPLACES a stored object on mutation (always `store.set(k,
   * { ...existing, ...patch })`) and NEVER mutates a stored object in place. If a
   * repo ever mutated a stored object's field directly, the snapshot would alias
   * the same object and rollback would silently keep the mutation. DO NOT mutate
   * stored objects in place; always set a fresh object. (Deep-clone here if that
   * invariant is ever relaxed.)
   */
  private snapshot() {
    return {
      suggestions: new Map(this.suggestions.store),
      suggestionsNatural: this.suggestions.snapshotNatural(),
      inventory: new Map(this.inventory.store),
      locations: new Map(this.locations.store),
      assets: new Map(this.assets.store),
      movements: [...this.movements.movements],
      materialStock: new Map(this.materialStock.store),
      returns: this.returns ? new Map(this.returns.store) : null,
    };
  }

  private restore(s: ReturnType<InMemoryUnitOfWork['snapshot']>): void {
    this.replaceMap(this.suggestions.store, s.suggestions);
    this.suggestions.restoreNatural(s.suggestionsNatural);
    this.replaceMap(this.inventory.store, s.inventory);
    this.replaceMap(this.locations.store, s.locations);
    this.replaceMap(this.assets.store, s.assets);
    this.movements.movements.length = 0;
    this.movements.movements.push(...s.movements);
    this.replaceMap(this.materialStock.store, s.materialStock);
    if (this.returns && s.returns) this.replaceMap(this.returns.store, s.returns);
  }

  private replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
    target.clear();
    for (const [k, v] of source) target.set(k, v);
  }
}

import { ContractInventoryRepository } from '@domain/ports/ContractInventoryRepository';
import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryMovementRepository } from '@domain/ports/InventoryMovementRepository';
import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';
import { ContractInstalledItem } from '@domain/entities/contract-installed-item';
import { InstalledItemNotFoundError, TechnicianRequiredError } from '@domain/errors/inventory';
import { RouteAssetToDisposition, RetireDisposition } from '@application/services/RouteAssetToDisposition';

export interface RetireInstalledItemInput {
  contractId: string;
  itemId: string;
  disposition: RetireDisposition;
  technicianId?: string | null;
  note?: string | null;
  /** Optional operator id, for future audit; not persisted yet. */
  actor?: string | null;
}

/**
 * RetireInstalledItem (Cambio B) — "Quitar con destino". Soft-deletes a
 * ContractInstalledItem AND routes its linked InventoryAsset to the chosen
 * destination (status/location/movement) in ONE transaction.
 *
 * Guard cascade (per design Decisión 3):
 *  1. item must exist                              → InstalledItemNotFoundError (404)
 *  2. item.contractId === contractId (scoping)     → InstalledItemNotFoundError (404)
 *  3. item.status !== 'active' → return as-is      (idempotent no-op, no movement)
 *  4. disposition==='TECNICO' && !technicianId     → TechnicianRequiredError (400)
 *  5. inventory.remove(item.id)                    (status → 'removed')
 *  6. if item.assetId → route.execute(b, {...})    (transition + relocation + ledger)
 *
 * A legacy item with `assetId = null` is only soft-deleted (no asset to route).
 * Everything inside runUnit is atomic: a failure rolls back the CII removal AND
 * the asset state.
 *
 * The W1 dual-write deps (assets/movements) + UnitOfWork are OPTIONAL — mirrors the
 * other inventory use cases, so a catalog-only call site still soft-deletes.
 */
export class RetireInstalledItem {
  constructor(
    private readonly inventory: ContractInventoryRepository,
    private readonly route: RouteAssetToDisposition,
    private readonly uow?: UnitOfWork,
    private readonly assets?: InventoryAssetRepository,
    private readonly movements?: InventoryMovementRepository,
  ) {}

  async execute(input: RetireInstalledItemInput): Promise<ContractInstalledItem> {
    return this.runUnit(async (b) => {
      const item = await b.inventory.getById(input.itemId);
      if (!item || item.contractId !== input.contractId) {
        throw new InstalledItemNotFoundError(input.itemId);
      }

      // Idempotent: an already-removed/replaced item is returned untouched — no
      // second movement, no double-routing of the asset.
      if (item.status !== 'active') return item;

      // Destination guard (defense-in-depth; the route's zod refine catches it first).
      if (input.disposition === 'TECNICO' && !input.technicianId) {
        throw new TechnicianRequiredError();
      }

      await b.inventory.remove(item.id);

      // Route the linked asset (transition + relocation + ledger). Legacy items
      // with no asset are only soft-deleted.
      if (item.assetId) {
        await this.route.execute(
          { assets: b.assets, movements: b.movements },
          {
            assetId: item.assetId,
            disposition: input.disposition,
            contractId: input.contractId,
            technicianId: input.technicianId,
            note: input.note,
          },
        );
      }

      const updated = await b.inventory.getById(item.id);
      // remove() already returned 'removed'; getById re-reads the canonical row.
      return updated ?? { ...item, status: 'removed' as const };
    });
  }

  /**
   * Runs the body inside the UnitOfWork when wired (tx-scoped repos), else against
   * the directly-injected repos. Mirrors RetireContractEquipment's runUnit.
   */
  private async runUnit(
    fn: (b: {
      inventory: ContractInventoryRepository;
      assets: InventoryAssetRepository;
      movements: InventoryMovementRepository;
    }) => Promise<ContractInstalledItem>,
  ): Promise<ContractInstalledItem> {
    if (this.uow) {
      return this.uow.runInTransaction((repos: TransactionalRepos) =>
        fn({
          inventory: repos.inventory,
          assets: repos.assets,
          movements: repos.movements,
        }),
      );
    }
    return fn({
      inventory: this.inventory,
      assets: this.assets as InventoryAssetRepository,
      movements: this.movements as InventoryMovementRepository,
    });
  }
}

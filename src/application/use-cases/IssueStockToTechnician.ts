import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { AssetNotAtDepotError } from '@domain/errors/inventory';

/** One issue line: EITHER a serialized asset OR a material+qty (XOR, like a movement). */
export type IssueItem =
  | { assetId: string }
  | { materialCatalogId: string; qty: number };

export interface IssueStockToTechnicianInput {
  items: IssueItem[];
}

function isAssetItem(item: IssueItem): item is { assetId: string } {
  return (item as { assetId?: string }).assetId != null;
}

/**
 * IssueStockToTechnician — operator-driven batch assignment of stock from the
 * DEPOSITO to a field technician (EPIC #38, Wave 5a).
 *
 * NAMING COLLISION — READ THIS:
 *   Operator "issue" = a **TRANSFER** movement (DEPOSITO → TECNICO), NOT the ledger
 *   `ISSUE` type. `ISSUE` is a material write-off (no `toLocation`, assets forbidden
 *   at the movement factory). This use case ALWAYS records `type: 'TRANSFER'` so the
 *   asset's `currentLocationId` moves to the technician and material balances move
 *   atomically depot→tecnico. NEVER emit `ISSUE` here.
 *
 * Atomicity: every item is recorded inside ONE `UnitOfWork.runInTransaction` —
 * all-or-nothing. If any item fails (asset not at depot, depot out of material
 * stock), the whole batch rolls back (same pattern as ConfirmAssetReturn).
 *
 * Depot + technician locations are resolved BEFORE the tx (find-or-create is
 * idempotent and side-effect-safe to repeat). Inside the tx each item is validated
 * then transferred.
 */
export class IssueStockToTechnician {
  constructor(
    private readonly resolveDepot: ResolveDepotLocation,
    private readonly resolveTechnician: ResolveTechnicianLocation,
    private readonly assets: InventoryAssetRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(technicianId: string, input: IssueStockToTechnicianInput): Promise<void> {
    const depot = await this.resolveDepot.execute('DEPOSITO');
    const techLoc = await this.resolveTechnician.execute(technicianId);

    await this.uow.runInTransaction(async (repos: TransactionalRepos) => {
      for (const item of input.items) {
        if (isAssetItem(item)) {
          // Guard: only an asset currently `available` AND physically at the depot
          // can be issued. An installed/elsewhere asset would be silently relocated
          // by the TRANSFER effect — refuse before any ledger write. The whole batch
          // rolls back on throw.
          const asset = await repos.assets.findById(item.assetId);
          if (!asset || asset.status !== 'available' || asset.currentLocationId !== depot.id) {
            throw new AssetNotAtDepotError(item.assetId);
          }
          await repos.movements.record({
            type: 'TRANSFER', // operator "issue" = TRANSFER movement, NOT the ISSUE type
            assetId: item.assetId,
            fromLocationId: depot.id,
            toLocationId: techLoc.id,
            technicianId,
            source: 'OPERATOR_ISSUE',
          });
        } else {
          await repos.movements.record({
            type: 'TRANSFER', // operator "issue" = TRANSFER movement, NOT the ISSUE type
            materialCatalogId: item.materialCatalogId,
            qty: item.qty,
            fromLocationId: depot.id,
            toLocationId: techLoc.id,
            technicianId,
            source: 'OPERATOR_ISSUE',
          });
        }
      }
    });
  }
}

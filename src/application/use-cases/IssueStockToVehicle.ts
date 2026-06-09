import { VehicleRepository } from '@domain/ports/VehicleRepository';
import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { ResolveVehicleLocation } from '@application/use-cases/ResolveVehicleLocation';
import { VehicleNotFoundError, VehicleInactiveError, AssetNotAtDepotError } from '@domain/errors/inventory';

/** One issue line: EITHER a serialized asset OR a material+qty (XOR, same as W5a). */
export type IssueItem =
  | { assetId: string }
  | { materialCatalogId: string; qty: number };

export interface IssueStockToVehicleInput {
  items: IssueItem[];
}

function isAssetItem(item: IssueItem): item is { assetId: string } {
  return (item as { assetId?: string }).assetId != null;
}

/**
 * IssueStockToVehicle — operator-driven batch assignment of stock from the
 * DEPOSITO to a vehicle's CAMIONETA location (EPIC #38, Wave 5b).
 *
 * Clones IssueStockToTechnician with CAMIONETA in place of TECNICO.
 *
 * Guards (checked before the UoW):
 * - Vehicle must exist → else VehicleNotFoundError (404)
 * - Vehicle must be active → else VehicleInactiveError (422)
 *
 * Atomicity: every item is recorded inside ONE UnitOfWork.runInTransaction —
 * all-or-nothing. If any item fails (asset not at depot, insufficient stock),
 * the whole batch rolls back.
 *
 * NAMING NOTE: operator "issue" = TRANSFER movement, NOT the ledger ISSUE type.
 */
export class IssueStockToVehicle {
  constructor(
    private readonly vehicles: VehicleRepository,
    private readonly resolveDepot: ResolveDepotLocation,
    private readonly resolveVehicle: ResolveVehicleLocation,
    private readonly assets: InventoryAssetRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(vehicleId: string, input: IssueStockToVehicleInput): Promise<void> {
    // Guard: vehicle must exist
    const vehicle = await this.vehicles.findById(vehicleId);
    if (!vehicle) throw new VehicleNotFoundError(vehicleId);

    // Guard: vehicle must be active (fail-fast before the UoW)
    if (vehicle.status !== 'active') throw new VehicleInactiveError(vehicleId);

    // Resolve locations before the tx (find-or-create is idempotent + side-effect-safe)
    const depot = await this.resolveDepot.execute('DEPOSITO');
    const vehLoc = await this.resolveVehicle.execute(vehicleId);

    await this.uow.runInTransaction(async (repos: TransactionalRepos) => {
      for (const item of input.items) {
        if (isAssetItem(item)) {
          // Guard: only an asset currently `available` AND physically at the depot
          const asset = await repos.assets.findById(item.assetId);
          if (!asset || asset.status !== 'available' || asset.currentLocationId !== depot.id) {
            throw new AssetNotAtDepotError(item.assetId);
          }
          await repos.movements.record({
            type: 'TRANSFER',
            assetId: item.assetId,
            fromLocationId: depot.id,
            toLocationId: vehLoc.id,
            source: 'OPERATOR_ISSUE',
          });
        } else {
          await repos.movements.record({
            type: 'TRANSFER',
            materialCatalogId: item.materialCatalogId,
            qty: item.qty,
            fromLocationId: depot.id,
            toLocationId: vehLoc.id,
            source: 'OPERATOR_ISSUE',
          });
        }
      }
    });
  }
}

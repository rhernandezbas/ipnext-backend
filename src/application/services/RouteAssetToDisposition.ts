import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryMovementRepository } from '@domain/ports/InventoryMovementRepository';
import { MovementType } from '@domain/entities/inventory-movement';
import { AssetStatus, nextStatus } from '@domain/entities/inventory-asset';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { ResolveTechnicianLocation } from '@application/use-cases/ResolveTechnicianLocation';
import { ResolveClientLocation } from '@application/use-cases/ResolveClientLocation';

/** Destinos posibles de un retiro con destino (Cambio B). */
export type RetireDisposition = 'DEPOSITO' | 'TECNICO' | 'CLIENTE' | 'DAMAGED' | 'RETIRED';

/** Subset of the tx-scoped repo bag that the routing actually mutates. */
export interface RouteAssetBag {
  assets: InventoryAssetRepository;
  movements: InventoryMovementRepository;
}

export interface RouteAssetInput {
  assetId: string;
  disposition: RetireDisposition;
  contractId: string;
  technicianId?: string | null;
  note?: string | null;
}

/**
 * Resolved routing target for a disposition: the asset's destination status, the
 * movement type, and whether the movement is an ADJUST that stamps the status.
 */
interface RoutingPlan {
  targetStatus: AssetStatus;
  movementType: MovementType;
  /** Only ADJUST movements carry an explicit asset status. */
  movementStatus: AssetStatus | null;
}

const ROUTING: Record<RetireDisposition, RoutingPlan> = {
  DEPOSITO: { targetStatus: 'available', movementType: 'RETURN', movementStatus: null },
  TECNICO: { targetStatus: 'available', movementType: 'TRANSFER', movementStatus: null },
  CLIENTE: { targetStatus: 'retired', movementType: 'ADJUST', movementStatus: 'retired' },
  DAMAGED: { targetStatus: 'damaged', movementType: 'ADJUST', movementStatus: 'damaged' },
  RETIRED: { targetStatus: 'retired', movementType: 'ADJUST', movementStatus: 'retired' },
};

/**
 * RouteAssetToDisposition (Cambio B) — shared, tx-scoped routing service. Given the
 * transactional repo bag plus `(assetId, disposition, contractId, technicianId?,
 * note?)`, it performs the **transition + relocation + ledger movement** for a
 * retire-with-destination. The asset starts `installed` at the contract's CLIENTE
 * location; each disposition routes it per the canonical table (see design):
 *
 *   DEPOSITO → available @ DEPOSITO   · RETURN
 *   TECNICO  → available @ TECNICO    · TRANSFER (technicianId)
 *   CLIENTE  → retired   @ CLIENTE    · ADJUST(status=retired)  (stays put)
 *   DAMAGED  → damaged   @ DEPOSITO   · ADJUST(status=damaged)
 *   RETIRED  → retired   @ DEPOSITO   · ADJUST(status=retired)
 *
 * CLIENTE→TECNICO is the net-new path (origin is CLIENTE/installed, not the depot
 * like IssueStockToTechnician). The find-or-create location resolvers are idempotent
 * and safe to run inside the tx.
 *
 * The location/status transition is computed BEFORE the movement and the movement's
 * own effect re-applies the SAME final state (single source of truth: the routing
 * table feeds both), so the explicit updates and the ledger never disagree.
 */
export class RouteAssetToDisposition {
  constructor(
    private readonly resolveDepot: ResolveDepotLocation,
    private readonly resolveTechnician: ResolveTechnicianLocation,
    private readonly resolveClient: ResolveClientLocation,
  ) {}

  async execute(b: RouteAssetBag, input: RouteAssetInput): Promise<void> {
    const asset = await b.assets.findById(input.assetId);
    if (!asset) return; // nothing to route (defensive — caller guards this)

    const plan = ROUTING[input.disposition];
    const from = asset.currentLocationId;
    const to = await this.resolveTargetLocation(input);

    // 1) Transition (validated by nextStatus — only legal transitions out of installed).
    await b.assets.updateStatus(input.assetId, nextStatus(asset.status, plan.targetStatus));

    // 2) Relocate only when the destination differs (CLIENTE keeps the asset in place).
    if (to !== from) {
      await b.assets.updateLocation(input.assetId, to);
    }

    // 3) Ledger movement. ADJUST stamps the explicit asset status; a non-empty note
    //    is required by the movement factory for ADJUST, so a sensible default is
    //    supplied when the operator left the note blank.
    await b.movements.record({
      type: plan.movementType,
      assetId: input.assetId,
      fromLocationId: from,
      toLocationId: to,
      technicianId: input.disposition === 'TECNICO' ? input.technicianId ?? undefined : undefined,
      source: 'OPERATOR_RETIRE',
      note: this.resolveNote(input, plan),
      status: plan.movementStatus ?? undefined,
    });
  }

  /** Resolves the destination location id for the disposition (find-or-create). */
  private async resolveTargetLocation(input: RouteAssetInput): Promise<string> {
    switch (input.disposition) {
      case 'TECNICO': {
        // TechnicianRequiredError is enforced upstream (RetireInstalledItem); guard here too.
        const techId = input.technicianId;
        if (!techId) {
          throw new Error('RouteAssetToDisposition: technicianId is required for TECNICO disposition');
        }
        return (await this.resolveTechnician.execute(techId)).id;
      }
      case 'CLIENTE':
        return (await this.resolveClient.execute(input.contractId)).id;
      case 'DEPOSITO':
      case 'DAMAGED':
      case 'RETIRED':
      default:
        return (await this.resolveDepot.execute('DEPOSITO')).id;
    }
  }

  /**
   * The operator note when present; otherwise undefined for movement types that allow
   * it (RETURN/TRANSFER — the adapter persists it as null) and a deterministic fallback
   * for ADJUST (the movement factory rejects an empty ADJUST note).
   */
  private resolveNote(input: RouteAssetInput, plan: RoutingPlan): string | undefined {
    const note = input.note?.trim();
    if (note) return note;
    if (plan.movementType === 'ADJUST') return `retire:${input.disposition.toLowerCase()}`;
    return undefined;
  }
}

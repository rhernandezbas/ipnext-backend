import { ReturnSuggestionRepository } from '@domain/ports/ReturnSuggestionRepository';
import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryMovementRepository } from '@domain/ports/InventoryMovementRepository';
import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import {
  ReturnSuggestion,
  ReturnResolution,
} from '@domain/entities/return-suggestion';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import {
  ReturnSuggestionNotFoundError,
  ReturnAlreadyResolvedError,
  ReturnHasNoAssetError,
  AssetNotReturnableError,
} from '@domain/errors/inventory';
import { randomUUID } from 'crypto';

export interface ConfirmAssetReturnInput {
  suggestionId: string;
  resolution: ReturnResolution;
  /** Required for the `link` resolution — the operator-chosen existing asset to RETURN. */
  linkedAssetId?: string | null;
  /** Optional audit context. */
  confirmedByUserId?: string | null;
}

/**
 * ConfirmAssetReturn — the ONLY stock mutation of the W4 returns flow (EPIC #38).
 *
 * Operator-driven. Resolves a `ReturnSuggestion` one of four ways:
 *   - `return` (matched): RETURN the matchedAssetId to DEPOSITO.
 *   - `link`   (no-match): RETURN an operator-chosen existing asset to DEPOSITO.
 *   - `create` (no-match): create a NEW asset already at DEPOSITO (available) — NO movement
 *      (no prior location to move FROM; the create IS the depot entry). OTROS deviceType fallback.
 *   - `discard`: mark discarded, no stock change.
 *
 * The mutating resolutions (`return`/`link`) run ONE atomic `RecordInventoryMovement(RETURN)`
 * inside the UnitOfWork — `computeAssetEffect(RETURN)` flips the asset to `available`@depot — and
 * stamp a deterministic `sourceRef` keyed on the ASSET (`iclass:return:{assetId}`, Fix #3) so the
 * invariant "asset X returned once" holds across serial drift / cross-suggestion. Defense in depth:
 *   - L1: a terminal suggestion (confirmed/discarded) is rejected before any ledger write.
 *   - Fix #1: re-check the asset is still `installed` inside the UoW → AssetNotReturnableError (409).
 *   - Fix #2: pre-write `movements.findBySourceRef` → already-returned asset → clean 409, no 2nd movement.
 *   - last resort: the sourceRef PARTIAL UNIQUE (a true race loser maps P2002 → 409 at the route).
 */
export class ConfirmAssetReturn {
  constructor(
    private readonly returns: ReturnSuggestionRepository,
    private readonly assets: InventoryAssetRepository,
    private readonly movements: InventoryMovementRepository,
    private readonly locations: StockLocationRepository,
    private readonly deviceTypes: DeviceTypeCatalogRepository,
    private readonly resolveDepot: ResolveDepotLocation,
    private readonly uow?: UnitOfWork,
  ) {}

  async execute(input: ConfirmAssetReturnInput): Promise<ReturnSuggestion> {
    const suggestion = await this.returns.get(input.suggestionId);
    if (!suggestion) throw new ReturnSuggestionNotFoundError(input.suggestionId);
    // L1: a terminal suggestion (confirmed/discarded) cannot be re-resolved. Catches the
    // single-operator double-click before any ledger write; sourceRef is the deeper defense.
    if (suggestion.status === 'confirmed' || suggestion.status === 'discarded') {
      throw new ReturnAlreadyResolvedError(suggestion.id, suggestion.status);
    }

    if (input.resolution === 'discard') {
      const updated = await this.returns.setStatus(suggestion.id, { status: 'discarded', resolution: 'discard' });
      return updated!;
    }

    if (input.resolution === 'create') {
      return this.handleCreate(suggestion);
    }

    // return | link → RETURN an existing asset to depot.
    const assetId =
      input.resolution === 'link' ? (input.linkedAssetId ?? null) : suggestion.matchedAssetId;
    if (!assetId) throw new ReturnHasNoAssetError(suggestion.id);

    return this.handleReturn(suggestion, input.resolution, assetId);
  }

  /**
   * Deterministic L2 natural key (Fix #3). For return/link the invariant is "this ASSET
   * already returned", so the key is the ASSET id — the partial-unique then enforces
   * "asset X returned once" regardless of serial drift or which suggestion triggered it.
   */
  private sourceRefForAsset(assetId: string): string {
    return `iclass:return:${assetId}`;
  }

  private async handleReturn(
    suggestion: ReturnSuggestion,
    resolution: ReturnResolution,
    assetId: string,
  ): Promise<ReturnSuggestion> {
    const sourceRef = this.sourceRefForAsset(assetId);

    return this.runUnit(async (b) => {
      // Fix #1: re-check the installed precondition INSIDE the UoW. A device moved or
      // returned between staging and confirm must NOT be silently flipped to available@depot.
      // Missing OR not installed → 409, no movement, no asset change. Also catches `link`
      // to a non-existent / non-installed asset (Finding 4).
      const asset = await b.assets.findById(assetId);
      if (!asset || asset.status !== 'installed') {
        throw new AssetNotReturnableError(assetId);
      }

      // Fix #2: L2 idempotency BEFORE the write — never rely on post-abort recovery inside a
      // poisoned tx. If a RETURN with this asset's sourceRef already exists, the asset is
      // already returned → clean idempotent reject (409), NO second movement.
      const existing = await b.movements.findBySourceRef(sourceRef);
      if (existing) {
        throw new ReturnAlreadyResolvedError(suggestion.id, 'confirmed');
      }

      const depot = await this.resolveDepot.execute('DEPOSITO');
      // ONE atomic RETURN. computeAssetEffect(RETURN) → asset available@depot. The partial
      // unique on sourceRef is the last-resort race guard (P2002 → 409 at the route).
      const movement = await b.movements.record({
        type: 'RETURN',
        assetId,
        toLocationId: depot.id,
        taskId: suggestion.taskId,
        source: 'ICLASS_RETIRO',
        sourceRef,
      });
      const updated = await b.returns.setStatus(suggestion.id, {
        status: 'confirmed',
        resolution,
        confirmedMovementId: movement.id, // Fix #5: the real uuid, not the sourceRef string
        sourceRef,
        matchedAssetId: assetId,
      });
      return updated!;
    });
  }

  /**
   * create-at-depot: the device pre-dates our ledger, so there is no prior location to
   * move FROM. We create the asset already `available`@DEPOSITO (the create IS the depot
   * entry) — NO movement. deviceType falls back to OTROS (like #19's dualWriteAsset).
   */
  private async handleCreate(suggestion: ReturnSuggestion): Promise<ReturnSuggestion> {
    return this.runUnit(async (b) => {
      const depot = await this.resolveDepot.execute('DEPOSITO');
      const otros = await this.deviceTypes.getByName('OTROS');
      const byHint = suggestion.deviceType ? await this.deviceTypes.getByName(suggestion.deviceType) : null;
      const deviceTypeId = (byHint ?? otros)?.id;
      // OTROS must exist (seeded). Guard defensively.
      if (!deviceTypeId) throw new ReturnHasNoAssetError(suggestion.id);

      const serial = suggestion.serialNumber && suggestion.serialNumber.trim()
        ? suggestion.serialNumber
        : `RET-${randomUUID()}`;

      const asset = await b.assets.create(
        createInventoryAsset({
          id: randomUUID(),
          serialNumber: serial,
          mac: suggestion.mac,
          deviceTypeId,
          status: 'available',
          currentLocationId: depot.id,
          source: 'ICLASS_RETIRO',
          sourceTaskId: suggestion.taskId,
        }),
      );
      const updated = await b.returns.setStatus(suggestion.id, {
        status: 'confirmed',
        resolution: 'create',
        matchedAssetId: asset.id,
      });
      return updated!;
    });
  }

  /**
   * Run `fn` inside the UnitOfWork (atomic) when wired; otherwise on the standalone repos.
   * The tx bag exposes the SAME repo shapes, so the confirm is all-or-nothing in prod and
   * rolls back cleanly in the in-memory adapter. `returns` falls back to the constructor
   * repo when the UoW does not provide a tx-scoped one (legacy wiring).
   */
  private async runUnit(
    fn: (b: { movements: InventoryMovementRepository; assets: InventoryAssetRepository; returns: ReturnSuggestionRepository; locations: StockLocationRepository }) => Promise<ReturnSuggestion>,
  ): Promise<ReturnSuggestion> {
    if (this.uow) {
      return this.uow.runInTransaction((repos: TransactionalRepos) =>
        fn({
          movements: repos.movements,
          assets: repos.assets,
          returns: repos.returns ?? this.returns,
          locations: repos.locations,
        }),
      );
    }
    return fn({
      movements: this.movements,
      assets: this.assets,
      returns: this.returns,
      locations: this.locations,
    });
  }
}

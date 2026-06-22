import { randomUUID } from 'crypto';
import { StockLocationRepository } from '@domain/ports/StockLocationRepository';
import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryMovementRepository } from '@domain/ports/InventoryMovementRepository';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { ResolveClientLocation } from '@application/use-cases/ResolveClientLocation';
import { createInventoryAsset, nextStatus } from '@domain/entities/inventory-asset';
import {
  AssetInstalledElsewhereError,
  AssetNotRevivableError,
  UnresolvableDeviceTypeError,
} from '@domain/errors/inventory';

/**
 * Tx-scoped repo bag the install helpers operate on. When a UnitOfWork drives the
 * write (inside `runInTransaction`) this is the tx-scoped bag; otherwise it is the
 * caller's standalone repos. Only the slots the install needs are required; the
 * rest of the confirm bag (suggestions, inventory) is irrelevant here.
 */
export interface InstallBag {
  locations?: StockLocationRepository;
  assets?: InventoryAssetRepository;
  movements?: InventoryMovementRepository;
  resolveClientLocation?: ResolveClientLocation;
}

export interface InstallNewArgs {
  contractId: string;
  type: string;
  serialNumber: string | null;
  mac: string | null;
  source: string;
  sourceTaskId: string | null;
  taskId: string | null;
  technicianId: string | null;
}

export interface ReconcileForEnrichArgs {
  /** The enriched item's existing assetId (null = legacy item → create one). */
  assetId: string | null;
  contractId: string;
  type: string;
  serialNumber: string | null;
  mac: string | null;
  source: string;
  sourceTaskId: string | null;
  taskId: string | null;
  technicianId: string | null;
}

/**
 * Shared install/dual-write service (design Decisión 2). Extracted verbatim from
 * `ConfirmInventorySuggestion.dualWriteAsset` so both the task-suggestion confirm
 * and the direct add (`AddContractEquipment`) materialize an `InventoryAsset`
 * (status=installed @ the contract's CLIENTE location) + an INSTALL movement
 * without duplicating logic. Lives in `application` and depends only on ports.
 */
export class InstallContractAsset {
  constructor(private readonly catalog: DeviceTypeCatalogRepository) {}

  /**
   * Dual-write side of an install: resolve the contract's CLIENTE location, create
   * (or scope-reuse) the unified InventoryAsset (status=installed, idempotent by
   * normalized serial / MAC), and record the INSTALL movement. Returns the asset id
   * to stamp onto the CII, or null when dual-write is not wired (no asset/movement/
   * location repos in the bag).
   *
   * Fix #2: serial reuse is SCOPED — an existing asset is reused only when it is
   * `available` OR already installed at THIS contract's CLIENTE location. An asset
   * `installed` elsewhere throws AssetInstalledElsewhereError instead of being
   * silently relocated.
   *
   * Fix #5: the deviceType NAME must resolve to a catalog id (or OTROS). If neither
   * resolves we throw UnresolvableDeviceTypeError rather than writing the raw NAME
   * into the deviceTypeId FK column.
   */
  async installNew(b: InstallBag, args: InstallNewArgs): Promise<string | null> {
    if (!b.resolveClientLocation || !b.assets || !b.movements) return null;

    const loc = await b.resolveClientLocation.execute(args.contractId);

    // Fix #5: resolve deviceTypeId by catalog NAME (UPPERCASE), OTROS fallback.
    // Never fall back to the raw NAME as the FK id.
    const byName = await this.catalog.getByName(args.type);
    const fallback = byName ? null : await this.catalog.getByName('OTROS');
    const resolvedType = byName ?? fallback;
    if (!resolvedType) throw new UnresolvableDeviceTypeError(args.type);
    const deviceTypeId = resolvedType.id;

    // Synthesize a stable serial when the device has none (MAC-only devices),
    // so the asset UNIQUE(serialNumber) holds.
    const hasMeaningfulSerial = !!(args.serialNumber && args.serialNumber.trim());
    const serial = hasMeaningfulSerial ? args.serialNumber! : `CII-${randomUUID()}`;

    // FIX A: use normalized serial lookup (any status/location) so OCR/manual drift
    // (case, dashes, spaces: "sn-001 " vs "SN001") doesn't create a silent duplicate.
    // Fall back to MAC lookup when there is no meaningful serial.
    let asset = hasMeaningfulSerial
      ? await b.assets.findByNormalizedSerialAny(serial)
      : args.mac
        ? await b.assets.findByMac(args.mac)
        : null;

    // Fix #2 (scoped idempotent reuse): reuse only when the asset is `available`
    // OR already at THIS contract's CLIENTE location; otherwise it is installed
    // elsewhere and reusing it would relocate someone else's device → refuse.
    let fromLocationId: string | undefined;
    if (asset) {
      const reusable = asset.status === 'available' || asset.currentLocationId === loc.id;
      if (!reusable) {
        throw new AssetInstalledElsewhereError(serial, asset.currentLocationId);
      }
      // Capture the asset's current location so the INSTALL movement records depot→client.
      if (asset.currentLocationId && asset.currentLocationId !== loc.id) {
        fromLocationId = asset.currentLocationId;
      }
    } else {
      asset = await b.assets.create(
        createInventoryAsset({
          id: randomUUID(),
          serialNumber: serial,
          mac: args.mac,
          deviceTypeId,
          status: 'installed',
          currentLocationId: loc.id,
          source: args.source,
          sourceTaskId: args.sourceTaskId,
        }),
      );
    }

    await b.movements.record({
      type: 'INSTALL',
      assetId: asset.id,
      fromLocationId,
      toLocationId: loc.id,
      taskId: args.taskId ?? undefined,
      technicianId: args.technicianId ?? undefined,
      source: args.source,
    });

    return asset.id;
  }

  /**
   * Enrich-time asset reconciliation (design Decisión 4). For an item being
   * enriched/revived:
   *  - No asset yet (legacy item, or the stamped id is gone) → delegate to
   *    `installNew` so the enriched equipment also becomes traceable.
   *  - Has an asset already installed at THIS contract → no-op revive; only backfill
   *    a null MAC.
   *  - Has an asset installed ELSEWHERE → refuse (AssetInstalledElsewhereError).
   *  - Has an asset that is `removed`/`available` → bring it to `installed` via the
   *    validated state machine (`removed → available → installed`, since
   *    `removed → installed` is illegal), move it to the CLIENTE location, backfill a
   *    null MAC, and record the INSTALL movement.
   *  - Has an asset that is `damaged`/`retired` → refuse (AssetNotRevivableError): a
   *    terminal asset cannot be silently re-installed.
   *
   * Returns the resolved asset id (to stamp onto the CII), or null when dual-write
   * is not wired.
   */
  async reconcileForEnrich(b: InstallBag, args: ReconcileForEnrichArgs): Promise<string | null> {
    if (!b.resolveClientLocation || !b.assets || !b.movements) return null;

    const installArgs: InstallNewArgs = {
      contractId: args.contractId,
      type: args.type,
      serialNumber: args.serialNumber,
      mac: args.mac,
      source: args.source,
      sourceTaskId: args.sourceTaskId,
      taskId: args.taskId,
      technicianId: args.technicianId,
    };

    // Legacy item with no asset → materialize one (so enriched equipment is traceable).
    if (!args.assetId) return this.installNew(b, installArgs);

    const asset = await b.assets.findById(args.assetId);
    // Stamped id points at a vanished row → treat as legacy, create anew.
    if (!asset) return this.installNew(b, installArgs);

    const loc = await b.resolveClientLocation.execute(args.contractId);

    // Already installed here → only backfill a null MAC; no movement/transition.
    if (asset.status === 'installed' && asset.currentLocationId === loc.id) {
      await this.backfillMac(b, asset.id, asset.mac, args.mac);
      return asset.id;
    }

    // Installed elsewhere → refuse (do not relocate someone else's device).
    if (asset.status === 'installed') {
      throw new AssetInstalledElsewhereError(asset.serialNumber, asset.currentLocationId);
    }

    // Bring the asset to `installed` via the validated state machine.
    //  - `removed`: legal revive, but ONLY through `available` (`removed → installed`
    //    is illegal by design), so step `removed → available → installed`. Both edges
    //    are now legal in TRANSITIONS.
    //  - `available`: a single legal `available → installed`.
    //  - `damaged`/`retired`: terminal — they CANNOT reach `installed`. Refuse with a
    //    clear domain error (AssetNotRevivableError → 409) instead of letting
    //    nextStatus throw the cryptic InvalidStatusTransitionError.
    if (asset.status === 'removed') {
      await b.assets.updateStatus(asset.id, nextStatus('removed', 'available'));
      await b.assets.updateStatus(asset.id, nextStatus('available', 'installed'));
    } else if (asset.status === 'available') {
      await b.assets.updateStatus(asset.id, nextStatus('available', 'installed'));
    } else {
      // damaged / retired → not revivable.
      throw new AssetNotRevivableError(asset.serialNumber, asset.status);
    }

    const fromLocationId =
      asset.currentLocationId && asset.currentLocationId !== loc.id ? asset.currentLocationId : undefined;
    if (asset.currentLocationId !== loc.id) {
      await b.assets.updateLocation(asset.id, loc.id);
    }

    await this.backfillMac(b, asset.id, asset.mac, args.mac);

    await b.movements.record({
      type: 'INSTALL',
      assetId: asset.id,
      fromLocationId,
      toLocationId: loc.id,
      taskId: args.taskId ?? undefined,
      technicianId: args.technicianId ?? undefined,
      source: args.source,
    });

    return asset.id;
  }

  /** COALESCE-style: set asset.mac only when it was null and the input carries one. */
  private async backfillMac(
    b: InstallBag,
    assetId: string,
    currentMac: string | null,
    incomingMac: string | null,
  ): Promise<void> {
    if (currentMac == null && incomingMac != null && b.assets) {
      await b.assets.updateMac(assetId, incomingMac);
    }
  }
}

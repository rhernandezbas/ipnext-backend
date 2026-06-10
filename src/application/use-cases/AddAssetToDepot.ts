import { InventoryAssetRepository } from '@domain/ports/InventoryAssetRepository';
import { InventoryMovementRepository } from '@domain/ports/InventoryMovementRepository';
import { DeviceTypeCatalogRepository } from '@domain/ports/DeviceTypeCatalogRepository';
import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';
import { ResolveDepotLocation } from '@application/use-cases/ResolveDepotLocation';
import { createInventoryAsset } from '@domain/entities/inventory-asset';
import { normalizeSerial, canonicalizeMac } from '@domain/entities/return-suggestion';
import {
  AssetAlreadyExistsError,
  AssetIdentifierRequiredError,
  DeviceTypeNotFoundError,
} from '@domain/errors/inventory';
import { randomUUID } from 'crypto';

export interface AddAssetToDepotInput {
  deviceTypeId: string;
  serialNumber?: string | null;
  mac?: string | null;
  note?: string | null;
}

export interface AddAssetToDepotOutput {
  id: string;
  deviceTypeId: string;
  deviceTypeName: string;
  serialNumber: string | null;
  mac: string | null;
  status: 'available';
}

/**
 * AddAssetToDepot — operator-driven manual stock entry for serialized assets
 * (EPIC #38 follow-up). Creates a NEW InventoryAsset at DEPOSITO (available)
 * and records an ADJUST ledger movement atomically inside a UnitOfWork.
 *
 * Semantics:
 *   - Type ADJUST, source MANUAL, toLocationId=depot — `computeAssetEffect(ADJUST)`
 *     sets asset.currentLocationId=depot and asset.status='available' (the status
 *     field is forwarded in the movement input per the port contract).
 *   - The asset create IS the depot entry (no prior location). The ADJUST movement
 *     provides the audit trail.
 *   - Duplicate guard: serialNumber (normalized, any status/location) OR mac (exact,
 *     any status/location) → 409 ASSET_ALREADY_EXISTS. An equipment can't exist twice.
 *   - At least one of serialNumber/mac required → 400 VALIDATION_ERROR.
 *   - deviceTypeId must exist in the catalog → 404 DEVICE_TYPE_NOT_FOUND.
 */
export class AddAssetToDepot {
  constructor(
    private readonly assets: InventoryAssetRepository,
    private readonly movements: InventoryMovementRepository,
    private readonly deviceTypes: DeviceTypeCatalogRepository,
    private readonly resolveDepot: ResolveDepotLocation,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(input: AddAssetToDepotInput): Promise<AddAssetToDepotOutput> {
    // 1) Completeness guard: at least one identifier required.
    const hasSerial = input.serialNumber != null && input.serialNumber.trim() !== '';
    const hasMac = input.mac != null && input.mac.trim() !== '';
    if (!hasSerial && !hasMac) {
      throw new AssetIdentifierRequiredError();
    }

    // 2) DeviceType lookup — 404 if unknown.
    const deviceType = await this.deviceTypes.getById(input.deviceTypeId);
    if (!deviceType) throw new DeviceTypeNotFoundError(input.deviceTypeId);

    // 3) Duplicate guard (pre-UoW; false negatives under true concurrency are caught
    //    by the DB unique constraint → P2002 → propagated as-is; use case layer stays
    //    adapter-agnostic and does not re-wrap Prisma errors here).
    //    FIX 2a: use findByNormalizedSerial (W4 normalized lookup) so variants like
    //    'SN-AAA-001' / 'SNAAA001' / 'sn-aaa-001' are treated as the SAME device.
    if (hasSerial) {
      const normalizedSn = normalizeSerial(input.serialNumber!);
      if (normalizedSn != null) {
        // Normalized lookup (any status/location): strips dashes/case so variants like
        // 'SN-AAA-001' and 'SNAAA001' are treated as the SAME device (FIX 2a).
        const dup = await this.assets.findByNormalizedSerialAny(input.serialNumber!.trim());
        if (dup) throw new AssetAlreadyExistsError('serialNumber', input.serialNumber!.trim());
      }
    }
    // W2: canonicalize the MAC before any lookup or storage so that 'aa-bb-cc-dd-ee-ff'
    // and 'AA:BB:CC:DD:EE:FF' are treated as the same address throughout the system.
    const canonicalMac = hasMac ? canonicalizeMac(input.mac!) : null;

    if (hasMac) {
      // Use canonical form for the dup lookup — findByMac also normalizes its arg
      // (W2c), but passing canonical here is explicit and avoids double-normalization.
      const dup = await this.assets.findByMac(canonicalMac ?? input.mac!.trim());
      if (dup) throw new AssetAlreadyExistsError('mac', input.mac!.trim());
    }

    // 4) Resolve depot (find-or-create idempotent).
    const depot = await this.resolveDepot.execute('DEPOSITO');

    const assetId = randomUUID();
    // FIX 5: synthetic serial for MAC-only entries. InventoryAsset.serialNumber is a
    // UNIQUE NOT NULL column — there is no nullable-serial escape hatch in the schema.
    // For MAC-only entries the operator never sees this value (the DTO returns serialNumber=null).
    // Format 'ENTRY-{8-hex}' is collision-resistant (2^32 space) and deterministic from
    // assetId, so a re-run that re-generates the same assetId would produce the same filler.
    // P2002 collision on this value is THEORETICAL (concurrent MAC-only entries for the same
    // assetId) and already caught by the P2002→409 handler in FIX 2b.
    const serialNumber = hasSerial ? input.serialNumber!.trim() : `ENTRY-${assetId.slice(0, 8).toUpperCase()}`;

    // 5) Atomic: create asset + record ADJUST movement.
    await this.uow.runInTransaction(async (repos: TransactionalRepos) => {
      await repos.assets.create(
        createInventoryAsset({
          id: assetId,
          serialNumber,
          // W2: store canonical MAC ('AA:BB:CC:DD:EE:FF') — raw input is normalized above.
          // If canonicalizeMac returns null (invalid format), fall back to trimmed raw.
          mac: hasMac ? (canonicalMac ?? input.mac!.trim()) : null,
          deviceTypeId: input.deviceTypeId,
          status: 'available',
          currentLocationId: depot.id,
          source: 'MANUAL',
          sourceTaskId: null,
        }),
      );
      // ADJUST movement: computeAssetEffect(ADJUST) with toLocationId+status
      // sets the asset's location to depot and status to 'available' (idempotent
      // on the just-created asset but provides the mandatory ledger audit trail).
      // Note: createInventoryMovement requires ADJUST to have a non-empty note.
      await repos.movements.record({
        type: 'ADJUST',
        assetId,
        toLocationId: depot.id,
        source: 'MANUAL',
        note: (input.note && input.note.trim()) ? input.note.trim() : 'Carga manual de stock al depósito',
        status: 'available',
      });
    });

    return {
      id: assetId,
      deviceTypeId: input.deviceTypeId,
      deviceTypeName: deviceType.name,
      serialNumber: hasSerial ? serialNumber : null,
      mac: hasMac ? (canonicalMac ?? input.mac!.trim()) : null,
      status: 'available',
    };
  }
}

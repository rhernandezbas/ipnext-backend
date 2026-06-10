import { InconsistentMovementError } from '@domain/errors/inventory';
import { AssetStatus } from '@domain/entities/inventory-asset';

export type MovementType =
  | 'ISSUE'
  | 'TRANSFER'
  | 'INSTALL'
  | 'RETURN'
  | 'CONSUME'
  | 'ADJUST';

/**
 * Registro inmutable de un evento de inventario. Lleva exactamente UNO de:
 * (assetId) o (materialCatalogId + qty>0). Una vez creado no se actualiza ni borra.
 */
export interface InventoryMovement {
  readonly id: string;
  readonly type: MovementType;
  readonly assetId: string | null;
  readonly materialCatalogId: string | null;
  readonly qty: number | null;
  readonly fromLocationId: string | null;
  readonly toLocationId: string | null;
  readonly taskId: string | null;
  readonly technicianId: string | null;
  readonly source: string;
  readonly note: string | null;
  readonly occurredAt: string;
  /** Optional explicit asset status — only meaningful for an ADJUST on an asset. */
  readonly status: AssetStatus | null;
  /**
   * Optional deterministic natural key for L2 idempotency (EPIC #38 W4 returns:
   * `iclass:return:{iclassId}:{normalizedSerial}`). A PARTIAL UNIQUE index on the
   * column makes a re-confirm collide → caught as P2002 and resolved to the
   * existing movement. Null for every other movement (the unique index ignores NULLs).
   */
  readonly sourceRef: string | null;
}

export interface CreateInventoryMovementInput {
  id: string;
  type: MovementType;
  assetId?: string | null;
  materialCatalogId?: string | null;
  qty?: number | null;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  taskId?: string | null;
  technicianId?: string | null;
  source: string;
  note?: string | null;
  occurredAt?: string | null;
  /** Only honored for ADJUST on an asset — lets an ADJUST set the asset status. */
  status?: AssetStatus | null;
  /** Optional L2 idempotency natural key (EPIC #38 W4). Null for non-return movements. */
  sourceRef?: string | null;
}

/**
 * Construye un movimiento inmutable (Object.freeze) validando:
 * - XOR: exactamente uno de (assetId) / (materialCatalogId + qty).
 * - qty > 0 para material (excepto ADJUST, que admite qty >= 0 — un conteo de 0
 *   es la corrección canónica) (Fix H2).
 * - CONSUME/ISSUE son verbos de material: NO pueden apuntar a un asset (Fix M1).
 * - Campos requeridos por tipo (Fix #4):
 *     INSTALL  → toLocationId
 *     RETURN   → toLocationId
 *     CONSUME  → fromLocationId
 *     ISSUE    → fromLocationId
 *     TRANSFER → fromLocationId + toLocationId
 *     ADJUST   → note no vacío; material ADJUST además requiere toLocationId (Fix H1)
 */
export function createInventoryMovement(input: CreateInventoryMovementInput): InventoryMovement {
  const hasAsset = input.assetId != null;
  const hasMaterial = input.materialCatalogId != null;

  if (hasAsset === hasMaterial) {
    throw new InconsistentMovementError(
      'exactly one of (assetId) or (materialCatalogId + qty) must be set',
    );
  }
  // Fix M1: CONSUME/ISSUE are consumable-only verbs. An asset leaves stock via
  // RETURN (back to depot) or a `removed`/`retired` ADJUST, never via CONSUME —
  // computeAssetEffect has no CONSUME case, so an asset CONSUME would record a
  // ledger row that changes nothing. Forbid it at the factory.
  if (hasAsset && (input.type === 'CONSUME' || input.type === 'ISSUE')) {
    throw new InconsistentMovementError(`${input.type} is a material movement and cannot target an asset`);
  }
  // ADJUST(material) is an ADDITIVE DELTA (depot-stock-entry fix wave: the adapters
  // apply it via the atomic `increment`, never SET — see both movement adapters).
  // qty>=0 is kept from the SET era: qty=0 is a tolerated no-op row; NEGATIVE
  // deltas (shrinkage corrections) are not supported yet — a future feature must
  // extend this guard AND the adapters together.
  if (hasMaterial) {
    const qtyOk =
      input.type === 'ADJUST'
        ? typeof input.qty === 'number' && input.qty >= 0
        : typeof input.qty === 'number' && input.qty > 0;
    if (!qtyOk) {
      throw new InconsistentMovementError(
        input.type === 'ADJUST'
          ? 'material ADJUST requires qty >= 0'
          : 'material movement requires qty > 0',
      );
    }
  }

  // Per-type required-field guards.
  const has = (v: string | null | undefined): boolean => v != null && v !== '';
  switch (input.type) {
    case 'INSTALL':
      if (!has(input.toLocationId)) throw new InconsistentMovementError('INSTALL requires toLocationId');
      break;
    case 'RETURN':
      if (!has(input.toLocationId)) throw new InconsistentMovementError('RETURN requires toLocationId');
      break;
    case 'CONSUME':
      if (!has(input.fromLocationId)) throw new InconsistentMovementError('CONSUME requires fromLocationId');
      break;
    case 'ISSUE':
      if (!has(input.fromLocationId)) throw new InconsistentMovementError('ISSUE requires fromLocationId');
      break;
    case 'TRANSFER':
      if (!has(input.fromLocationId)) throw new InconsistentMovementError('TRANSFER requires fromLocationId');
      if (!has(input.toLocationId)) throw new InconsistentMovementError('TRANSFER requires toLocationId');
      break;
    case 'ADJUST':
      if (!(typeof input.note === 'string' && input.note.trim() !== '')) {
        throw new InconsistentMovementError('ADJUST requires a non-empty note');
      }
      // Fix H1: a MATERIAL ADJUST applies its delta AT a location — without a
      // toLocationId the adapters would write to `toLocationId!` (null → FK
      // violation in Prisma, phantom "M1::undefined" key in-memory). Require it.
      // An ASSET ADJUST has no location target (it sets status), so it's exempt.
      if (hasMaterial && !has(input.toLocationId)) {
        throw new InconsistentMovementError('material ADJUST requires toLocationId');
      }
      break;
  }

  const mv: InventoryMovement = {
    id: input.id,
    type: input.type,
    assetId: input.assetId ?? null,
    materialCatalogId: input.materialCatalogId ?? null,
    qty: hasMaterial ? input.qty! : null,
    fromLocationId: input.fromLocationId ?? null,
    toLocationId: input.toLocationId ?? null,
    taskId: input.taskId ?? null,
    technicianId: input.technicianId ?? null,
    source: input.source,
    note: input.note ?? null,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    status: input.status ?? null,
    sourceRef: input.sourceRef ?? null,
  };
  return Object.freeze(mv);
}

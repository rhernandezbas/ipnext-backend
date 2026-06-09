import { InventoryMovement } from '@domain/entities/inventory-movement';
import { AssetStatus } from '@domain/entities/inventory-asset';

/**
 * Efecto materializado de un movimiento sobre el activo serializado.
 * ÚNICA fuente de verdad — los adapters Prisma e in-memory DEBEN derivar el
 * post-estado del asset desde esta función pura (sin switches paralelos).
 *
 * Por tipo:
 *   INSTALL  → { currentLocationId: toLocationId, status: 'installed' }
 *   RETURN   → { currentLocationId: toLocationId(depot), status: 'available' }
 *   TRANSFER → { currentLocationId: toLocationId } (si presente)
 *   ADJUST   → { currentLocationId? y/o status? tomados del movimiento }
 *
 * Nota (Fix M1): CONSUME/ISSUE son verbos de material — el factory los rechaza
 * para assets, así que esta función nunca los recibe con un assetId.
 */
export interface AssetEffect {
  currentLocationId?: string;
  status?: AssetStatus;
}

export function computeAssetEffect(mv: InventoryMovement): AssetEffect {
  const effect: AssetEffect = {};

  switch (mv.type) {
    case 'INSTALL':
      if (mv.toLocationId) effect.currentLocationId = mv.toLocationId;
      effect.status = 'installed';
      break;
    case 'RETURN':
      if (mv.toLocationId) effect.currentLocationId = mv.toLocationId;
      effect.status = 'available';
      break;
    case 'TRANSFER':
      if (mv.toLocationId) effect.currentLocationId = mv.toLocationId;
      break;
    case 'ADJUST':
      if (mv.toLocationId) effect.currentLocationId = mv.toLocationId;
      if (mv.status) effect.status = mv.status;
      break;
    default:
      break;
  }

  return effect;
}

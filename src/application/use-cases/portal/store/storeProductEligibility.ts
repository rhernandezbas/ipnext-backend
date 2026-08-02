import type { StoreProduct } from '@domain/entities/storeProduct';

/**
 * store-backend — "¿este producto lo puede ver/comprar un cliente AHORA?":
 * `active=true` Y `archivedAt=null`. Función pura compartida por
 * `GetPortalStoreProduct` (re-chequeo del detalle), `GetPortalStoreProductImage`
 * (la imagen no debe filtrarse de un producto invisible) y
 * `PlaceStorePortalOrder` (antes de crear un pedido) — UNA sola
 * implementación, mismo criterio que `isPortalPromoEligibleNow`.
 */
export function isStoreProductVisible(product: Pick<StoreProduct, 'active' | 'archivedAt'>): boolean {
  return product.active && product.archivedAt === null;
}

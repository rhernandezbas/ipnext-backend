import type { StoreProduct } from '@domain/entities/storeProduct';

/**
 * store-backend — DTOs client-facing (`GET /api/portal/store/products`,
 * `GET /api/portal/store/products/:id`).
 *
 * `imageUrl` — computado a partir de `imageStorageKey` (MinIO, mismo patrón
 * que `PortalPromoSummaryDto.imageUrl`) como una URL relativa DETERMINÍSTICA
 * (`/api/portal/store/products/{id}/image`); `null` cuando el producto no
 * tiene imagen. A DIFERENCIA de portal-promos (donde esa ruta quedó SIN
 * implementar — deuda documentada), acá la rebanada está COMPLETA: la ruta
 * existe y sirve el binario (ver `portal.routes.ts` / `GetPortalStoreProductImage`).
 *
 * `installmentArs` — redondeo: `Math.round(priceArs / maxInstallments * 100) / 100`
 * (redondeo estándar "half away from zero" de JS a 2 decimales, el mismo
 * criterio simple que el resto del repo usa para montos ARS — NO hay reparto
 * de centavos entre cuotas: la ÚLTIMA cuota no absorbe el resto de un
 * `priceArs` no divisible exacto por `maxInstallments`. Documentado en el
 * reporte del change: para `priceArs=10000, maxInstallments=3` da
 * `3333.33` × 3 = `9999.99` (1 centavo menos que el total) — aceptado a
 * propósito por simplicidad en v1 (sin pasarela, la factura real la arma GR,
 * este número es informativo para el cliente en la card).
 */
export interface StoreProductSummaryDto {
  id: string;
  title: string;
  summary: string;
  priceArs: number;
  maxInstallments: number;
  installmentArs: number;
  badge: string | null;
  imageUrl: string | null;
  warrantyText: string;
}

export interface StoreProductDetailDto extends StoreProductSummaryDto {
  description: string;
}

export function toStoreProductImageUrl(product: Pick<StoreProduct, 'id' | 'imageStorageKey'>): string | null {
  return product.imageStorageKey ? `/api/portal/store/products/${product.id}/image` : null;
}

export function computeInstallmentArs(priceArs: number, maxInstallments: number): number {
  return Math.round((priceArs / maxInstallments) * 100) / 100;
}

export function toStoreProductSummaryDto(product: StoreProduct): StoreProductSummaryDto {
  return {
    id: product.id,
    title: product.title,
    summary: product.summary,
    priceArs: product.priceArs,
    maxInstallments: product.maxInstallments,
    installmentArs: computeInstallmentArs(product.priceArs, product.maxInstallments),
    badge: product.badge,
    imageUrl: toStoreProductImageUrl(product),
    warrantyText: product.warrantyText,
  };
}

export function toStoreProductDetailDto(product: StoreProduct): StoreProductDetailDto {
  return {
    ...toStoreProductSummaryDto(product),
    description: product.description,
  };
}

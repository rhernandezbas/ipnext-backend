import type { PortalPromo } from '@domain/entities/portalPromo';

/**
 * portal-promos — DTOs client-facing (`GET /api/portal/promos`,
 * `GET /api/portal/promos/:id`).
 *
 * `imageUrl` — computado a partir de `imageStorageKey` (MinIO, mismo patrón
 * que los adjuntos de mensajería) como una URL relativa DETERMINÍSTICA
 * (`/api/portal/promos/{id}/image`); `null` cuando la promo no tiene imagen.
 * NOTA (fuera de alcance de este batch, ver reporte): la ruta que sirve el
 * buffer de esa imagen NO está implementada — la sección 3 de la spec lista
 * taxativamente 4 endpoints y ninguno es de imagen. `imageStorageKey` se
 * puebla hoy solo vía el CRUD admin (string plano), sin un flujo de subida
 * dedicado.
 */
export interface PortalPromoSummaryDto {
  id: string;
  title: string;
  summary: string;
  imageUrl: string | null;
  ctaLabel: string;
  endsAt: string;
}

export interface PortalPromoDetailDto extends PortalPromoSummaryDto {
  body: string;
}

export function toPortalPromoImageUrl(promo: Pick<PortalPromo, 'id' | 'imageStorageKey'>): string | null {
  return promo.imageStorageKey ? `/api/portal/promos/${promo.id}/image` : null;
}

export function toPortalPromoSummaryDto(promo: PortalPromo): PortalPromoSummaryDto {
  return {
    id: promo.id,
    title: promo.title,
    summary: promo.summary,
    imageUrl: toPortalPromoImageUrl(promo),
    ctaLabel: promo.ctaLabel,
    endsAt: promo.endsAt,
  };
}

export function toPortalPromoDetailDto(promo: PortalPromo): PortalPromoDetailDto {
  return {
    ...toPortalPromoSummaryDto(promo),
    body: promo.body,
  };
}

import type { PortalPromoSummaryDto } from './portalPromo.dto';

/**
 * portal-benefits — DTOs de `GET /api/portal/benefits` (pestaña Catálogo, con
 * dos solapas: Disponibles/Activados).
 *
 * `available` reusa EXACTAMENTE el shape de `PortalPromoSummaryDto` (la misma
 * tarjeta que ya renderiza Inicio) — no un tipo paralelo: es literalmente el
 * mismo dato mostrado en otro lugar de la app.
 */
export type PortalBenefitAvailableDto = PortalPromoSummaryDto;

/**
 * `active` mezcla 3 orígenes SIN tabla nueva (ver `ListPortalBenefits`):
 *  - 'promo':   una promo con `PortalPromoResponse.kind='interested'`.
 *  - 'service': un `ContractService` activo de un contrato activo.
 *  - 'tenure':  UNA sola entrada derivada del contrato más antiguo del cliente.
 */
export type PortalActiveBenefitKind = 'promo' | 'service' | 'tenure';

export interface PortalActiveBenefitDto {
  kind: PortalActiveBenefitKind;
  title: string;
  /** null para 'tenure' (no hay nada más que decir aparte del título). */
  detail: string | null;
  since: string;
}

export interface PortalBenefitsDto {
  available: PortalBenefitAvailableDto[];
  active: PortalActiveBenefitDto[];
}

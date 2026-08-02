import type { CampaignSegmentFilter } from '@domain/ports/CustomerRepository';

/**
 * portal-promos — entidad de dominio. `segment` reusa `CampaignSegmentFilter`
 * (el mismo shape que ya consume `listSegmentRecipients`/`clientMatchesSegment`)
 * en vez de inventar un tipo paralelo — es la garantía de que "lo que el
 * operador configura" y "lo que el motor de segmentos entiende" son
 * literalmente el mismo objeto, sin una capa de traducción que pueda divergir.
 */
export interface PortalPromo {
  id: string;
  title: string;
  summary: string;
  body: string;
  imageStorageKey: string | null;
  ctaLabel: string;
  ticketAreaId: string | null;
  segment: CampaignSegmentFilter;
  startsAt: string;
  endsAt: string;
  /** null = borrador, NO visible para clientes. */
  publishedAt: string | null;
  archivedAt: string | null;
  authorId: string | null;
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

/** 'interested' = tocó el CTA (abrió un reclamo); 'dismissed' = "no me interesa". */
export type PortalPromoResponseKind = 'interested' | 'dismissed';

export interface PortalPromoResponse {
  id: string;
  promoId: string;
  clientId: string;
  kind: PortalPromoResponseKind;
  /** Solo presente cuando kind='interested'. */
  ticketId: string | null;
  createdAt: string;
}

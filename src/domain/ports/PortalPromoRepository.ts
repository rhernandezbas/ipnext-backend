import type { PortalPromo } from '@domain/entities/portalPromo';
import type { CampaignSegmentFilter } from '@domain/ports/CustomerRepository';

export interface CreatePortalPromoData {
  title: string;
  summary: string;
  body: string;
  imageStorageKey?: string | null;
  ctaLabel?: string;
  ticketAreaId?: string | null;
  segment: CampaignSegmentFilter;
  startsAt: Date;
  endsAt: Date;
  /** Ausente/null = queda en borrador (publishedAt null). */
  publishedAt?: Date | null;
  authorId: string | null;
  authorName: string;
}

/**
 * Partial update — SOLO las keys presentes cambian. `publishedAt`/`archivedAt`
 * siguen el criterio `undefined = no tocar` / `null = limpiar` / `Date =
 * setear` (mismo patrón que `UpdateTicketData.areaId`) — así el mismo método
 * sirve para publicar (`publishedAt: new Date()`), volver a borrador
 * (`publishedAt: null`), archivar (`archivedAt: new Date()`) y desarchivar
 * (`archivedAt: null`) sin 4 endpoints separados.
 */
export interface UpdatePortalPromoData {
  title?: string;
  summary?: string;
  body?: string;
  imageStorageKey?: string | null;
  ctaLabel?: string;
  ticketAreaId?: string | null;
  segment?: CampaignSegmentFilter;
  startsAt?: Date;
  endsAt?: Date;
  publishedAt?: Date | null;
  archivedAt?: Date | null;
}

export interface PortalPromoRepository {
  create(data: CreatePortalPromoData): Promise<PortalPromo>;
  update(id: string, patch: UpdatePortalPromoData): Promise<PortalPromo | null>;
  findById(id: string): Promise<PortalPromo | null>;
  /** Admin — TODAS las promos (borrador/publicada/archivada), createdAt desc. */
  list(): Promise<PortalPromo[]>;
  /**
   * portal-promos — promos POTENCIALMENTE visibles ahora mismo:
   * `publishedAt` no null, `archivedAt` null, `startsAt <= now <= endsAt`.
   * El caller (`ListPortalPromos`/`GetPortalPromo`) TODAVÍA debe aplicar el
   * filtro de segmento (`SegmentMembershipChecker.clientMatchesSegment`) y el
   * de "no respondió antes" — esta query no conoce al cliente, solo acota el
   * universo de promos candidatas (esperado: pocas decenas activas a la vez,
   * nunca miles — a diferencia de la lista de clientes).
   */
  listActive(now: Date): Promise<PortalPromo[]>;
}

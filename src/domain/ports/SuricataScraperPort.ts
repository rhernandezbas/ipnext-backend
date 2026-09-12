import type { SuricataMessageAuthorKind } from '@domain/entities/suricata';

/**
 * suricata-tickets-mirror (Phase C, D3) — the ONLY read surface the sync use
 * case sees into Suricata Cx. Deliberately READ-ONLY (MIRROR-8): there is no
 * write/update method on this port at all, so a use case literally cannot
 * mutate Suricata through it — the type system enforces the same invariant
 * `suricata-content-hash.test.ts`/the MIRROR-8 guard test asserts at runtime.
 *
 * D3.b — a SEPARATE `SuricataReplyPort` (Phase E) is the only thing that
 * writes to a real client, gated by RBAC + double confirmation. Merging the
 * two into one port would make it impossible to inject the scraper into a
 * background job without also handing it the ability to reply.
 *
 * D3.c — the domain/use case never sees the shared-session lock: adapters
 * (`PlaywrightSuricataScraper`) call `SuricataSession.withSession` internally,
 * per port method (D0: "por PÁGINA de la lista ... suelta el mutex entre
 * páginas" — the release-per-unit-of-work granularity lives inside each
 * method's implementation, not in this signature).
 */
export interface SuricataAreaSummary {
  externalId: string;
  name: string;
}

/**
 * Row-level shape shown by Suricata's ticket LIST view. `messageCount` lets
 * `contentHash` be computed WITHOUT opening the ticket detail (D6.b — "si el
 * hash no cambió, no se abre el detalle").
 */
export interface SuricataTicketSummary {
  externalId: string;
  subject: string;
  status: string;
  priority: string | null;
  areaExternalId: string | null;
  lastMessageAt: string | null;
  messageCount: number;
}

export interface SuricataTicketPage {
  tickets: SuricataTicketSummary[];
  hasNextPage: boolean;
}

export interface SuricataScrapedAttachmentRef {
  externalRef: string;
  fileName: string;
  mimeType?: string;
  sizeBytes?: number | null;
}

export interface SuricataScrapedMessage {
  externalId: string;
  author: string;
  authorKind: SuricataMessageAuthorKind;
  body: string;
  sentAt: string;
  attachments: SuricataScrapedAttachmentRef[];
}

export interface SuricataTicketDetail {
  externalId: string;
  subject: string;
  status: string;
  priority: string | null;
  areaExternalId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  externalClientRef: string | null;
  openedAt: string | null;
  lastMessageAt: string | null;
  messages: SuricataScrapedMessage[];
}

export interface SuricataFetchedAttachment {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export interface SuricataScraperPort {
  listAreas(): Promise<SuricataAreaSummary[]>;
  /** 1-indexed, ordered by activity descending (D6.a). */
  listTicketPage(page: number): Promise<SuricataTicketPage>;
  getTicket(externalId: string): Promise<SuricataTicketDetail>;
  fetchAttachment(ref: string): Promise<SuricataFetchedAttachment>;
}

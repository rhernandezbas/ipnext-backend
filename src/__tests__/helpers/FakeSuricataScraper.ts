import type {
  SuricataScraperPort,
  SuricataAreaSummary,
  SuricataTicketPage,
  SuricataTicketDetail,
  SuricataFetchedAttachment,
} from '@domain/ports/SuricataScraperPort';

/**
 * suricata-tickets-mirror (Phase C, task C.4, D3/D12) — test double for
 * `SuricataScraperPort`. `SyncSuricataTickets` tests configure this instead of
 * mocking Playwright or parsing HTML fixtures directly — same "test double
 * over the port, not the adapter" convention as `FakeChatwootGateway`.
 *
 * Configure behavior by mutating the public fields directly before calling
 * `execute()`.
 */
export class FakeSuricataScraper implements SuricataScraperPort {
  /** Populate before calling `listAreas()`. */
  public areas: SuricataAreaSummary[] = [];

  /** 1-indexed pages — `pagesByNumber.get(1)` answers `listTicketPage(1)`. */
  public pagesByNumber = new Map<number, SuricataTicketPage>();
  public listTicketPageCalls: number[] = [];

  /** Keyed by `externalId`. */
  public ticketDetailsByExternalId = new Map<string, SuricataTicketDetail>();
  /** `externalId`s that must throw when `getTicket` is called (MIRROR-4 — per-ticket retry). */
  public failingTicketExternalIds = new Set<string>();
  public getTicketCalls: string[] = [];

  /** Keyed by attachment `externalRef`. */
  public attachmentsByRef = new Map<string, SuricataFetchedAttachment>();
  public failingAttachmentRefs = new Set<string>();
  public fetchAttachmentCalls: string[] = [];

  async listAreas(): Promise<SuricataAreaSummary[]> {
    return this.areas;
  }

  async listTicketPage(page: number): Promise<SuricataTicketPage> {
    this.listTicketPageCalls.push(page);
    return this.pagesByNumber.get(page) ?? { tickets: [], hasNextPage: false };
  }

  async getTicket(externalId: string): Promise<SuricataTicketDetail> {
    this.getTicketCalls.push(externalId);
    if (this.failingTicketExternalIds.has(externalId)) {
      throw new Error(`fake: scrape failed for ticket ${externalId}`);
    }
    const detail = this.ticketDetailsByExternalId.get(externalId);
    if (!detail) throw new Error(`fake: no ticket detail fixture registered for ${externalId}`);
    return detail;
  }

  async fetchAttachment(ref: string): Promise<SuricataFetchedAttachment> {
    this.fetchAttachmentCalls.push(ref);
    if (this.failingAttachmentRefs.has(ref)) {
      throw new Error(`fake: attachment fetch failed for ${ref}`);
    }
    const attachment = this.attachmentsByRef.get(ref);
    if (!attachment) throw new Error(`fake: no attachment fixture registered for ${ref}`);
    return attachment;
  }
}

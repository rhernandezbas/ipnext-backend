/**
 * suricata-tickets-mirror (Phase C, task C.3, D6.d) — every CSS selector the
 * scraper touches lives HERE, as named constants, so a DOM change is a
 * one-file diff and a `selectorMisses` audit trail is possible. Pure parsers
 * (cheerio, no network — molde `parseSeamOSDetail.ts`) live alongside them:
 * `PlaywrightSuricataScraper` fetches HTML/binary via the shared session and
 * hands it here.
 *
 * D6.d's two hard invariants (page 1 must yield >=1 ticket; a missing required
 * field is a `selectorMisses` entry) are enforced by `SyncSuricataTickets`
 * (the use case), NOT here: a parser that throws on a broken/redesigned DOM
 * would turn "selector roto" into an unhandled exception instead of the
 * loud-but-controlled `SuricataSyncRun.outcome='failed'` the design specifies.
 * These functions degrade to empty/`null` fields and never throw.
 */
import * as cheerio from 'cheerio';
import type { SuricataMessageAuthorKind } from '@domain/entities/suricata';
import type {
  SuricataAreaSummary,
  SuricataTicketPage,
  SuricataTicketSummary,
  SuricataTicketDetail,
  SuricataScrapedMessage,
  SuricataScrapedAttachmentRef,
} from '@domain/ports/SuricataScraperPort';

export const SURICATA_SELECTORS = {
  areaRow: '.area-row',
  ticketRow: '.ticket-row',
  ticketSubject: '.ticket-subject',
  ticketStatus: '.ticket-status',
  ticketPriority: '.ticket-priority',
  ticketArea: '.ticket-area',
  ticketLastMessageAt: '.ticket-last-message',
  ticketMessageCount: '.ticket-message-count',
  paginationNext: 'a.pagination-next',
  detailRoot: '.ticket-detail',
  detailSubject: '.ticket-detail-subject',
  detailStatus: '.ticket-detail-status',
  detailPriority: '.ticket-detail-priority',
  detailArea: '.ticket-detail-area',
  detailCustomer: '.ticket-detail-customer',
  detailOpenedAt: '.ticket-detail-opened-at',
  detailLastMessageAt: '.ticket-detail-last-message-at',
  messageRow: '.message-row',
  messageBody: '.message-body',
  attachmentLink: 'a.attachment-link',
} as const;

function toIntOrZero(raw: string): number {
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? 0 : n;
}

export function parseSuricataAreaList(html: string): SuricataAreaSummary[] {
  const $ = cheerio.load(html);
  const areas: SuricataAreaSummary[] = [];
  $(SURICATA_SELECTORS.areaRow).each((_i, el) => {
    const $el = $(el);
    const externalId = $el.attr('data-area-id');
    const name = $el.text().trim();
    if (!externalId || !name) return; // malformed row -- skip, never throw
    areas.push({ externalId, name });
  });
  return areas;
}

export function parseSuricataTicketListPage(html: string): SuricataTicketPage {
  const $ = cheerio.load(html);
  const tickets: SuricataTicketSummary[] = [];
  $(SURICATA_SELECTORS.ticketRow).each((_i, el) => {
    const $el = $(el);
    const externalId = $el.attr('data-ticket-id');
    if (!externalId) return; // malformed row -- skip

    const subject = $el.find(SURICATA_SELECTORS.ticketSubject).first().text().trim();
    const status = $el.find(SURICATA_SELECTORS.ticketStatus).first().attr('data-status') ?? '';
    const priority = $el.find(SURICATA_SELECTORS.ticketPriority).first().attr('data-priority') ?? null;
    const areaExternalId = $el.find(SURICATA_SELECTORS.ticketArea).first().attr('data-area-id') ?? null;
    const lastMessageAt =
      $el.find(SURICATA_SELECTORS.ticketLastMessageAt).first().attr('data-last-message-at') ?? null;
    const messageCountRaw = $el.find(SURICATA_SELECTORS.ticketMessageCount).first().text().trim();

    tickets.push({
      externalId,
      subject,
      status,
      priority,
      areaExternalId,
      lastMessageAt,
      messageCount: messageCountRaw ? toIntOrZero(messageCountRaw) : 0,
    });
  });

  const hasNextPage = $(SURICATA_SELECTORS.paginationNext).length > 0;
  return { tickets, hasNextPage };
}

export function parseSuricataTicketDetail(html: string): SuricataTicketDetail {
  const $ = cheerio.load(html);
  const root = $(SURICATA_SELECTORS.detailRoot).first();

  const externalId = root.attr('data-ticket-id') ?? '';
  const subject = root.find(SURICATA_SELECTORS.detailSubject).first().text().trim();
  const status = root.find(SURICATA_SELECTORS.detailStatus).first().attr('data-status') ?? '';
  const priority = root.find(SURICATA_SELECTORS.detailPriority).first().attr('data-priority') ?? null;
  const areaExternalId = root.find(SURICATA_SELECTORS.detailArea).first().attr('data-area-id') ?? null;

  const customerEl = root.find(SURICATA_SELECTORS.detailCustomer).first();
  const customerName = customerEl.attr('data-name') ?? null;
  const customerEmail = customerEl.attr('data-email') ?? null;
  const customerPhone = customerEl.attr('data-phone') ?? null;
  const externalClientRef = customerEl.attr('data-external-ref') ?? null;

  const openedAt = root.find(SURICATA_SELECTORS.detailOpenedAt).first().attr('data-opened-at') ?? null;
  const lastMessageAt =
    root.find(SURICATA_SELECTORS.detailLastMessageAt).first().attr('data-last-message-at') ?? null;

  const messages: SuricataScrapedMessage[] = [];
  root.find(SURICATA_SELECTORS.messageRow).each((_i, el) => {
    const $el = $(el);
    const msgExternalId = $el.attr('data-message-id');
    if (!msgExternalId) return; // malformed message row -- skip

    const author = $el.attr('data-author') ?? '';
    const authorKindRaw = $el.attr('data-author-kind') ?? 'unknown';
    const authorKind: SuricataMessageAuthorKind = (
      ['customer', 'agent', 'system', 'unknown'] as const
    ).includes(authorKindRaw as SuricataMessageAuthorKind)
      ? (authorKindRaw as SuricataMessageAuthorKind)
      : 'unknown';
    const sentAt = $el.attr('data-sent-at') ?? '';
    const body = $el.find(SURICATA_SELECTORS.messageBody).first().text().trim();

    const attachments: SuricataScrapedAttachmentRef[] = [];
    $el.find(SURICATA_SELECTORS.attachmentLink).each((_j, a) => {
      const $a = $(a);
      const href = $a.attr('href');
      if (!href) return;
      const sizeRaw = $a.attr('data-size-bytes');
      attachments.push({
        externalRef: href,
        fileName: $a.attr('data-filename') ?? href.split('/').pop() ?? href,
        mimeType: $a.attr('data-mime-type') ?? undefined,
        sizeBytes: sizeRaw ? Number(sizeRaw) : null,
      });
    });

    messages.push({ externalId: msgExternalId, author, authorKind, body, sentAt, attachments });
  });

  return {
    externalId,
    subject,
    status,
    priority,
    areaExternalId,
    customerName,
    customerEmail,
    customerPhone,
    externalClientRef,
    openedAt,
    lastMessageAt,
    messages,
  };
}

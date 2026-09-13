/**
 * suricata-tickets-mirror (Phase C, task C.3, D6.d; RE-VERIFIED against the
 * live system 2026-09-13) — every CSS selector / route the scraper touches
 * lives HERE. The ORIGINAL version of this file (apply session, no Suricata
 * access) was entirely hand-authored and, once checked against the real
 * `ipnext.suricata.cloud` instance, turned out to be wrong on every point:
 * wrong login field names, a login-form marker that never matches ANYTHING
 * (so `isAuthenticated()` always reported "authenticated" and login was never
 * attempted), wrong list/detail routes (`/tickets` doesn't exist -- it 500s),
 * and a list page whose ticket rows are injected by client-side JS (there is
 * no server-rendered `<tr>` to scrape at all).
 *
 * The values below were captured live, authenticated, via Playwright MCP
 * against `https://ipnext.suricata.cloud` on 2026-09-13.
 */
import * as cheerio from 'cheerio';
import type { SuricataAreaSummary, SuricataTicketPage, SuricataTicketSummary, SuricataTicketDetail } from '@domain/ports/SuricataScraperPort';

export const SURICATA_AUTH_PATHS = {
  /** The login FORM is served at `/` itself when there is no session; it POSTs to `/login`. */
  authenticatedProbe: '/',
  loginPath: '/',
} as const;

export const SURICATA_AUTH_SELECTORS = {
  usernameField: 'input[name="email"]',
  passwordField: 'input[name="password"]',
  /** The only `<button>` inside the login form; it has no `type="submit"` attribute (relies on the HTML default). */
  submitButton: 'form button',
  /**
   * `isAuthenticated()`'s DOM marker: the password field is present ONLY on
   * the login page, on ANY route, so its absence means we're logged in.
   */
  notAuthenticatedMarker: 'input[name="password"]',
} as const;

/** `/ticketsdinamicosv2` renders an EMPTY `<tbody>`; rows are injected by client JS from `/api/tickets-dinamicos`. */
const TICKETS_LIST_PATH = '/ticketsdinamicosv2';
const TICKET_DETAIL_PATH = '/ticketunico';
const TICKETS_DATA_API_PATH = '/api/tickets-dinamicos';

export const SURICATA_ROUTES = { TICKETS_LIST_PATH, TICKET_DETAIL_PATH, TICKETS_DATA_API_PATH } as const;

/** The department `<select>` embedded in `TICKETS_LIST_PATH`'s HTML -- the only place real numeric area ids exist; the ticket rows/JSON only ever carry the area NAME. */
export function parseSuricataAreaOptions(html: string): SuricataAreaSummary[] {
  const $ = cheerio.load(html);
  const areas: SuricataAreaSummary[] = [];
  $('select#department option').each((_i, el) => {
    const $el = $(el);
    const externalId = $el.attr('value');
    const name = $el.text().trim();
    if (!externalId || externalId === '0' || !name) return; // "Seleccionar" placeholder -- skip
    areas.push({ externalId, name });
  });
  return areas;
}

/** `TICKETS_LIST_PATH`'s inline bootstrap script sets `usuariologeado = '<id>'` -- the numeric id `TICKETS_DATA_API_PATH?usuario=<id>` needs. */
export function extractLoggedInUserId(html: string): string | null {
  const match = html.match(/usuariologeado\s*=\s*'(\d+)'/);
  return match ? match[1] : null;
}

interface SuricataTicketsDinamicosBadge {
  texto?: string | null;
}

export interface SuricataTicketsDinamicosTicket {
  id: number;
  siennadepto?: SuricataTicketsDinamicosBadge | null;
  siennatopic?: SuricataTicketsDinamicosBadge | null;
  prioridad?: SuricataTicketsDinamicosBadge | null;
  siennaestado?: SuricataTicketsDinamicosBadge | null;
  /** Timestamp of the last conversation activity -- NOT `fn` (ticket creation). */
  fechadeconv?: string | null;
}

export interface SuricataTicketsDinamicosResponse {
  tickets: SuricataTicketsDinamicosTicket[];
}

/**
 * Suricata renders every timestamp as `YYYY-MM-DD HH:mm:ss`, Argentina LOCAL
 * time (UTC-3, no DST) -- confirmed live 2026-09-13 (a ticket's `fechadeconv`
 * matched the wall-clock time of the action, not UTC). Prisma's `DateTime`
 * columns need real ISO 8601 with an offset/zone; handing it the raw string
 * made every single ticket fail with "Invalid `prisma...upsert()` invocation"
 * (caught, logged, and the run marked `degraded` -- `ticketsSeen` was
 * correct, `ticketsUpserted` stayed 0 for every ticket).
 */
function toIsoArgentina(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
  if (!match) return raw; // already ISO or unrecognized -- pass through rather than mangle
  return `${match[1]}T${match[2]}-03:00`;
}

/**
 * `TICKETS_DATA_API_PATH` returns every ticket visible to the logged-in agent
 * in ONE response -- no `page`/`limit` params, confirmed live (21 of 21 in a
 * single call). It is NOT pre-sorted by activity: the UI's apparent order
 * comes from DataTables' own client-side sort, not the API. `listTicketPage`
 * (D6.a: "ordered by activity descending") sorts here, once.
 *
 * `messageCount` has no source in this API -- set to 0. D6.b's "skip if
 * unchanged" optimization still works: `lastMessageAt` changes on every new
 * message, which is already part of the hash.
 */
export function parseSuricataTicketsDinamicos(
  json: SuricataTicketsDinamicosResponse,
  areaNameToId: ReadonlyMap<string, string>,
): SuricataTicketPage {
  const tickets: SuricataTicketSummary[] = (json.tickets ?? [])
    .slice()
    .sort((a, b) => (b.fechadeconv ?? '').localeCompare(a.fechadeconv ?? ''))
    .map((t) => {
      const areaName = t.siennadepto?.texto ?? null;
      return {
        externalId: String(t.id),
        // Suricata has no free-text "subject" -- the topic ("Tema de ayuda")
        // is the closest real concept and is what the UI itself shows as the
        // ticket's title.
        subject: t.siennatopic?.texto ?? '',
        status: t.siennaestado?.texto ?? '',
        priority: t.prioridad?.texto ?? null,
        areaExternalId: areaName ? (areaNameToId.get(areaName) ?? null) : null,
        lastMessageAt: toIsoArgentina(t.fechadeconv),
        messageCount: 0,
      };
    });
  // Confirmed live 2026-09-13: one call returns the full active set, no
  // offset/limit exists upstream to paginate further.
  return { tickets, hasNextPage: false };
}

function textAfterLabelDiv($: cheerio.CheerioAPI, label: string): string | null {
  let result: string | null = null;
  $('div.d-flex').each((_i, el) => {
    const $el = $(el);
    if ($el.text().trim().startsWith(label)) {
      const text = $el.find('span').first().text().trim();
      if (text) result = text;
    }
  });
  return result;
}

function textAfterStrongLabel($: cheerio.CheerioAPI, label: string): string | null {
  let result: string | null = null;
  $('strong').each((_i, el) => {
    const $el = $(el);
    if ($el.text().trim() === label) {
      const text = $el.parent().text().replace(label, '').trim();
      if (text) result = text;
    }
  });
  return result;
}

/**
 * `TICKET_DETAIL_PATH` IS server-rendered (unlike the list): status/dept/
 * priority/topic and the customer info panel are all present in the raw
 * HTML, no JS required. `externalId` is passed in rather than scraped -- the
 * caller already knows it (it built the request URL from it).
 *
 * `messages` is always `[]`: the actual conversation thread renders inside a
 * cross-origin iframe (`https://conversation.suricata.chat/...`), a separate
 * client-rendered app that needs a live websocket to populate -- there is
 * NOTHING to scrape for it in this page's HTML. Mirroring message content is
 * a separate, unsolved problem (see suricata-tickets-mirror follow-up notes),
 * not a selector fix.
 */
export function parseSuricataTicketDetail(
  html: string,
  externalId: string,
  areaNameToId: ReadonlyMap<string, string>,
): SuricataTicketDetail {
  const $ = cheerio.load(html);

  const status = $('#ticketStatusName').first().text().trim();
  const priority = $('#ticketPriorityName').first().text().trim() || null;
  const areaName = $('#ticketDeptoName').first().text().trim() || null;
  const subject = $('#ticketTopicName').first().text().trim();

  return {
    externalId,
    subject,
    status,
    priority,
    areaExternalId: areaName ? (areaNameToId.get(areaName) ?? null) : null,
    customerName: textAfterLabelDiv($, 'Nombre:'),
    customerEmail: textAfterLabelDiv($, 'Email:'),
    customerPhone: textAfterLabelDiv($, 'Teléfono:'),
    externalClientRef: textAfterLabelDiv($, 'Número cliente:'),
    openedAt: toIsoArgentina(textAfterStrongLabel($, 'Creado:')),
    // No reliable "last message" field found on this page -- the caller
    // falls back to the list summary's `lastMessageAt` (SyncSuricataTickets).
    lastMessageAt: null,
    messages: [],
  };
}

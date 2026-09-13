/**
 * suricata-tickets-mirror (Phase C, task C.4, D0/D3) — the ONLY adapter that
 * actually talks to Suricata Cx. D0: "por PÁGINA de la lista:
 * session.withSession(prio=LOW, fn) ← suelta el mutex entre páginas" — every
 * port method acquires and releases the shared session independently, per
 * unit of work, never once for the whole run.
 *
 * DEVIATION (documented, pending Phase J): `playwright-core` is NOT a
 * dependency yet — task J.1 adds it, version-pinned exact, in its own
 * isolated PR (D5). This class therefore depends on the narrow structural
 * `SuricataBrowserSession` interface below (same pattern Phase B used for
 * `SuricataAuthSession`) instead of importing `BrowserContext`/`chromium`
 * directly. `bootstrapSuricataSync` (task C.10) only constructs this scraper
 * when `SURICATA_BROWSER_WS` is set, and that env is never set in prod until
 * Phase J lands the sidecar + the real `SuricataBrowserSession` implementation
 * on top of `context.request.get`/a real page — exactly D14's "Deploy DARK"
 * step. This class is correct and fully unit-tested TODAY; it simply has no
 * live caller until then.
 */
import type {
  SuricataScraperPort,
  SuricataAreaSummary,
  SuricataTicketPage,
  SuricataTicketDetail,
  SuricataFetchedAttachment,
} from '@domain/ports/SuricataScraperPort';
import { SuricataAttachmentInvalidOriginError } from '@domain/errors/suricata';
import { SuricataSession, type SuricataAuthSession } from './SuricataSession';
import {
  SURICATA_ROUTES,
  parseSuricataAreaOptions,
  extractLoggedInUserId,
  parseSuricataTicketsDinamicos,
  parseSuricataTicketDetail,
  type SuricataTicketsDinamicosResponse,
} from './selectors';
import { fetchLastBotpressMessages } from './botpressMessages';

/**
 * Slug del merchant en Suricata/Botpress -- fijo, no es un secreto (ya
 * aparece en cada URL de la plataforma). Exportado (suricata-bot-autonomous-
 * actions, Phase G) para que `BotpressReplyAdapter` reuse el MISMO literal en
 * vez de duplicarlo.
 */
export const SURICATA_MERCHANT = 'ipnext';

/**
 * Narrow structural contract `PlaywrightSuricataScraper` needs on top of
 * `SuricataAuthSession`. Phase J's real implementation backs `fetchHtml` with
 * `page.content()` after `page.goto(url)`, and `fetchBinary` with
 * `context.request.get(url)` (D5 — reuses the authenticated cookie, works
 * against a REMOTE browser, unlike the filesystem-assuming `download` API).
 */
export interface SuricataBrowserSession extends SuricataAuthSession {
  fetchHtml(url: string): Promise<string>;
  fetchJson<T>(
    url: string,
    opts?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown },
  ): Promise<T>;
  fetchBinary(url: string): Promise<{ buffer: Buffer; mimeType: string }>;
}

export interface PlaywrightSuricataScraperConfig {
  baseUrl: string;
  /** D4 — the sync lane always requests the session at 'low' priority. */
  sessionTimeoutMs: number;
}

function resolveUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

/** Only these two ever reach the sidecar. `file:`, `data:`, `gopher:` etc. are out. */
const ALLOWED_ATTACHMENT_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * SSRF guard for attachment refs (fix wave).
 *
 * `listAreas`/`listTicketPage`/`getTicket` build their URLs from constants, so
 * `new URL(path, baseUrl)` there is always same-origin by construction. An
 * ATTACHMENT ref is different: it is an `href` lifted verbatim out of
 * Suricata's HTML, i.e. attacker-influenceable input. And `new URL` DISCARDS
 * the base whenever the ref is absolute (`http://169.254.169.254/...`) or
 * protocol-relative (`//evil.example.com/...`) — so "resolving against baseUrl"
 * is not, by itself, any containment at all.
 *
 * The sidecar runs inside the internal Docker network, holds an authenticated
 * session, and whatever it downloads gets persisted to MinIO and served back
 * through our own attachment route. So this compares the RESOLVED origin
 * (scheme + host + port) against `baseUrl`'s and refuses anything else, before
 * a single byte is requested.
 */
function assertSameOriginAttachment(baseUrl: string, resolvedUrl: string): void {
  let resolved: URL;
  let base: URL;
  try {
    resolved = new URL(resolvedUrl);
    base = new URL(baseUrl);
  } catch {
    throw new SuricataAttachmentInvalidOriginError();
  }

  if (!ALLOWED_ATTACHMENT_PROTOCOLS.has(resolved.protocol)) {
    throw new SuricataAttachmentInvalidOriginError();
  }
  // `origin` folds scheme + host + port together, so an http downgrade or a
  // port swap on the same hostname is rejected too.
  if (resolved.origin !== base.origin) {
    throw new SuricataAttachmentInvalidOriginError();
  }
}

export class PlaywrightSuricataScraper implements SuricataScraperPort {
  constructor(
    private readonly session: SuricataSession<SuricataBrowserSession>,
    private readonly cfg: PlaywrightSuricataScraperConfig,
  ) {}

  /**
   * `TICKETS_LIST_PATH`'s HTML is the ONLY place real numeric area ids exist
   * (embedded `<select id="department">`); it also carries the logged-in
   * agent's numeric id (`usuariologeado`), which `TICKETS_DATA_API_PATH`
   * requires as `?usuario=`. Both `listAreas` and `listTicketPage` need this
   * same fetch, so it is factored here rather than duplicated.
   */
  private async loadAreasAndSession(
    s: SuricataBrowserSession,
  ): Promise<{ areas: SuricataAreaSummary[]; areaNameToId: Map<string, string>; loggedInUserId: string | null }> {
    const html = await s.fetchHtml(resolveUrl(this.cfg.baseUrl, SURICATA_ROUTES.TICKETS_LIST_PATH));
    const areas = parseSuricataAreaOptions(html);
    const areaNameToId = new Map(areas.map((a) => [a.name, a.externalId]));
    const loggedInUserId = extractLoggedInUserId(html);
    return { areas, areaNameToId, loggedInUserId };
  }

  async listAreas(): Promise<SuricataAreaSummary[]> {
    return this.session.withSession({ priority: 'low', timeoutMs: this.cfg.sessionTimeoutMs }, async (s) => {
      const { areas } = await this.loadAreasAndSession(s);
      return areas;
    });
  }

  async listTicketPage(page: number): Promise<SuricataTicketPage> {
    return this.session.withSession({ priority: 'low', timeoutMs: this.cfg.sessionTimeoutMs }, async (s) => {
      // Confirmed live 2026-09-13: `TICKETS_DATA_API_PATH` returns the FULL
      // active set in one response, no offset/limit exists upstream -- page 1
      // is the whole answer, any later page is empty.
      if (page > 1) return { tickets: [], hasNextPage: false };

      const { areaNameToId, loggedInUserId } = await this.loadAreasAndSession(s);
      const url = resolveUrl(
        this.cfg.baseUrl,
        `${SURICATA_ROUTES.TICKETS_DATA_API_PATH}?usuario=${encodeURIComponent(loggedInUserId ?? '')}`,
      );
      const json = await s.fetchJson<SuricataTicketsDinamicosResponse>(url);
      return parseSuricataTicketsDinamicos(json, areaNameToId);
    });
  }

  async getTicket(externalId: string): Promise<SuricataTicketDetail> {
    return this.session.withSession({ priority: 'low', timeoutMs: this.cfg.sessionTimeoutMs }, async (s) => {
      const { areaNameToId } = await this.loadAreasAndSession(s);
      const html = await s.fetchHtml(
        resolveUrl(this.cfg.baseUrl, `${SURICATA_ROUTES.TICKET_DETAIL_PATH}?tick=${encodeURIComponent(externalId)}`),
      );
      const detail = parseSuricataTicketDetail(html, externalId, areaNameToId);
      // El hilo real vive en Botpress, no en este HTML (ver botpressMessages.ts)
      // -- degrada a [] sola, nunca bloquea el mirror de metadata del ticket.
      const messages = await fetchLastBotpressMessages(s, SURICATA_MERCHANT, externalId);
      return { ...detail, messages };
    });
  }

  async fetchAttachment(ref: string): Promise<SuricataFetchedAttachment> {
    // Validated BEFORE the mutex is acquired: a hostile ref should not make the
    // sync lane queue up behind (or hold up) anything.
    const url = resolveUrl(this.cfg.baseUrl, ref);
    assertSameOriginAttachment(this.cfg.baseUrl, url);

    return this.session.withSession({ priority: 'low', timeoutMs: this.cfg.sessionTimeoutMs }, async (s) => {
      const { buffer, mimeType } = await s.fetchBinary(url);
      const fileName = ref.split('/').pop() || ref;
      return { buffer, mimeType, fileName };
    });
  }
}

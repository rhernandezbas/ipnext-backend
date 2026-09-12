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
import { parseSuricataAreaList, parseSuricataTicketListPage, parseSuricataTicketDetail } from './selectors';

/**
 * Narrow structural contract `PlaywrightSuricataScraper` needs on top of
 * `SuricataAuthSession`. Phase J's real implementation backs `fetchHtml` with
 * `page.content()` after `page.goto(url)`, and `fetchBinary` with
 * `context.request.get(url)` (D5 — reuses the authenticated cookie, works
 * against a REMOTE browser, unlike the filesystem-assuming `download` API).
 */
export interface SuricataBrowserSession extends SuricataAuthSession {
  fetchHtml(url: string): Promise<string>;
  fetchBinary(url: string): Promise<{ buffer: Buffer; mimeType: string }>;
}

export interface PlaywrightSuricataScraperConfig {
  baseUrl: string;
  /** D4 — the sync lane always requests the session at 'low' priority. */
  sessionTimeoutMs: number;
}

const AREAS_PATH = '/areas';
const TICKETS_LIST_PATH = '/tickets';
const TICKET_DETAIL_PATH = '/tickets';

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

  async listAreas(): Promise<SuricataAreaSummary[]> {
    return this.session.withSession({ priority: 'low', timeoutMs: this.cfg.sessionTimeoutMs }, async (s) => {
      const html = await s.fetchHtml(resolveUrl(this.cfg.baseUrl, AREAS_PATH));
      return parseSuricataAreaList(html);
    });
  }

  async listTicketPage(page: number): Promise<SuricataTicketPage> {
    return this.session.withSession({ priority: 'low', timeoutMs: this.cfg.sessionTimeoutMs }, async (s) => {
      const html = await s.fetchHtml(resolveUrl(this.cfg.baseUrl, `${TICKETS_LIST_PATH}?page=${page}`));
      return parseSuricataTicketListPage(html);
    });
  }

  async getTicket(externalId: string): Promise<SuricataTicketDetail> {
    return this.session.withSession({ priority: 'low', timeoutMs: this.cfg.sessionTimeoutMs }, async (s) => {
      const html = await s.fetchHtml(
        resolveUrl(this.cfg.baseUrl, `${TICKET_DETAIL_PATH}/${encodeURIComponent(externalId)}`),
      );
      return parseSuricataTicketDetail(html);
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

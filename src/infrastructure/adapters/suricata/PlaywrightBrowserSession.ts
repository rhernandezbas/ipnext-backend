/**
 * PlaywrightBrowserSession (suricata-tickets-mirror, Phase J, task J.1, D5) —
 * the REAL `SuricataBrowserSession` implementation, backed by `playwright-core`
 * connecting to the remote sidecar (`chromium.connect(wsEndpoint)`, D5's
 * chosen Option C). This is the ONLY file in the whole change that imports
 * `playwright-core` directly: every use case, port, and the mutex
 * (`SuricataSession`, Phase B) stay structurally blind to it (D3.c) — Phase
 * C/E's real adapters (`PlaywrightSuricataScraper`, `PlaywrightSuricataReply`)
 * only depend on the narrow `SuricataBrowserSession`/`SuricataReplySession`
 * interfaces this class (and a future reply counterpart) implement.
 *
 * SCOPE (this phase): only the SYNC lane (read-only scraping) gets a real
 * driver. `composeSuricataModule.ts` still wires `UnavailableSuricataReplyPort`
 * unconditionally for replies (Phase E's conservative guard) — this class is
 * never used by the reply path, on purpose, per this apply session's explicit
 * scope boundary.
 *
 * Auth/route selectors were RE-VERIFIED live against the real Suricata Cx
 * DOM on 2026-09-13 (see `selectors.ts`'s top comment) after the original
 * hand-authored ones turned out to be wrong on every point.
 *
 * Connects LAZILY: the WebSocket connection to the sidecar (and the browser
 * context) only opens on the FIRST call that needs it — never during
 * `bootstrapSuricataSync` itself. D5/D11: "vacío ⇒ feature apagada, sin tirar
 * al boot" — and a temporarily-unreachable sidecar must not crash the server
 * boot either, only fail the next sync tick, which
 * `SuricataSyncScheduler.runOnce` already catches and logs without crashing
 * (molde `ChatMediaDownloadScheduler`).
 *
 * ...and RECONNECTS: a failed connect is never memoized, and a `disconnected`
 * browser drops the cached context, so a sidecar that boots late or restarts
 * recovers on the next tick instead of requiring a BE restart.
 */
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { SuricataAttachmentTooLargeError, SuricataAttachmentInvalidOriginError, SuricataActionNotAppliedError } from '@domain/errors/suricata';
import type { SuricataBrowserSession } from './PlaywrightSuricataScraper';
import type { SuricataInternalNoteSession } from './PlaywrightSuricataInternalNote';
import type { SuricataStatusSession } from './PlaywrightSuricataStatus';
import type { SuricataCloseSession } from './PlaywrightSuricataClose';
import { SURICATA_AUTH_SELECTORS, SURICATA_AUTH_PATHS, SURICATA_ROUTES } from './selectors';
import { SURICATA_TICKET_DETAIL_PATH, SURICATA_INTERNAL_NOTE_SELECTORS, SURICATA_BULK_ACTION_SELECTORS } from './actionSelectors';

export interface PlaywrightBrowserSessionConfig {
  /** ws:// endpoint of the Playwright `run-server` sidecar (D5). */
  browserWs: string;
  baseUrl: string;
  username: string;
  password: string;
  /**
   * D7.b's per-attachment ceiling, pushed down to the adapter so it can be
   * enforced on the DECLARED size before the body is materialized. The
   * buffer-length check in `SyncSuricataTickets` stays as the backstop.
   */
  maxAttachmentBytes: number;
}

function resolveUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

export class PlaywrightBrowserSession
  implements SuricataBrowserSession, SuricataInternalNoteSession, SuricataStatusSession, SuricataCloseSession
{
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private connecting: Promise<BrowserContext> | null = null;

  constructor(private readonly cfg: PlaywrightBrowserSessionConfig) {}

  /**
   * Memoized for the HAPPY path only: while a connection is live,
   * `chromium.connect` runs once. It is deliberately NOT memoized across
   * failures — see `connect()`.
   */
  private ensureContext(): Promise<BrowserContext> {
    if (this.context) return Promise.resolve(this.context);
    if (!this.connecting) this.connecting = this.connect();
    return this.connecting;
  }

  private async connect(): Promise<BrowserContext> {
    try {
      const browser = await chromium.connect(this.cfg.browserWs);

      // The sidecar is a separate container: it restarts, gets redeployed, and
      // dies. Without this, `this.context` would keep pointing at a dead
      // browser and EVERY later call would fail on it until the BE itself was
      // restarted. Clearing both fields makes the next call reconnect.
      browser.on('disconnected', () => {
        this.browser = null;
        this.context = null;
        this.connecting = null;
      });

      this.browser = browser;
      this.context = await browser.newContext();
      return this.context;
    } catch (err) {
      // CRITICAL: drop the memo on failure. A rejected promise left in
      // `this.connecting` is cached forever, so a sidecar that simply had not
      // finished booting when the first tick fired would keep "failing" for
      // the life of the process even once it is perfectly healthy — every
      // later tick just re-awaits the same stale rejection. Resetting here
      // makes the next tick a genuine fresh attempt. The scheduler's interval
      // is the backoff (molde `ChatMediaDownloadScheduler`); there is no retry
      // loop inside this method.
      this.browser = null;
      this.context = null;
      this.connecting = null;
      throw err;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      await page.goto(resolveUrl(this.cfg.baseUrl, SURICATA_AUTH_PATHS.authenticatedProbe), {
        waitUntil: 'domcontentloaded',
      });
      const notAuthenticatedCount = await page.locator(SURICATA_AUTH_SELECTORS.notAuthenticatedMarker).count();
      return notAuthenticatedCount === 0;
    } finally {
      await page.close();
    }
  }

  async login(): Promise<void> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      await page.goto(resolveUrl(this.cfg.baseUrl, SURICATA_AUTH_PATHS.loginPath), {
        waitUntil: 'domcontentloaded',
      });
      await page.locator(SURICATA_AUTH_SELECTORS.usernameField).fill(this.cfg.username);
      await page.locator(SURICATA_AUTH_SELECTORS.passwordField).fill(this.cfg.password);
      await page.locator(SURICATA_AUTH_SELECTORS.submitButton).click();
      await page.waitForLoadState('domcontentloaded');
    } catch (err) {
      // D4 — a raw Playwright failure here (selector not found, navigation
      // timeout against a real/changed DOM) is NOT the typed error contract:
      // `ensureAuthenticated` (SuricataSession.ts, Phase B) re-checks
      // `isAuthenticated()` right after this call and is the ONE place that
      // raises the typed `SuricataAuthError` on a second failure. Swallowing
      // the raw error here keeps that single, already-tested contract as the
      // only surface — never a blind retry loop (D4).
      console.warn('[suricata-session] login attempt failed:', (err as Error).message);
    } finally {
      await page.close();
    }
  }

  /**
   * RESIDUAL (accepted): `page.goto` has no redirect switch, so this method
   * cannot pin the final origin the way `fetchBinary` does. Scoped risk: every
   * url reaching here is built by `PlaywrightSuricataScraper` from
   * `cfg.baseUrl` + a constant path — never from an href in third-party HTML —
   * and the result is parsed into typed rows, never persisted as raw bytes.
   */
  async fetchHtml(url: string): Promise<string> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      // `page.goto` never rejects on a non-2xx response (e.g. a 404/500 error
      // page) -- without this check a broken route silently "succeeds" with
      // the error page's HTML, which then parses as zero rows.
      const status = response?.status();
      if (status !== undefined && (status < 200 || status >= 300)) {
        throw new Error(`Suricata request to ${url} failed with status ${status}`);
      }
      return await page.content();
    } finally {
      await page.close();
    }
  }

  /**
   * Plain JSON fetch, no browser rendering -- used for `TICKETS_DATA_API_PATH`
   * (Suricata's own JSON API, authenticated via the shared cookie jar) AND
   * for the Botpress message lookup (`backend.suricata.chat`/
   * `api.botpress.cloud`, unrelated hosts reached with their OWN
   * Authorization header, no Suricata cookie needed). Reuses
   * `context.request` exactly like `fetchBinary` -- the sidecar's outbound
   * network is not restricted to `baseUrl`.
   */
  async fetchJson<T>(
    url: string,
    opts?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown },
  ): Promise<T> {
    const context = await this.ensureContext();
    const requestOpts = { headers: opts?.headers, data: opts?.body };
    const response =
      opts?.method === 'POST' ? await context.request.post(url, requestOpts) : await context.request.get(url, requestOpts);
    const status = response.status();
    if (status < 200 || status >= 300) {
      throw new Error(`Suricata request to ${url} failed with status ${status}`);
    }
    return (await response.json()) as T;
  }

  async fetchBinary(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
    // D5 — `context.request` (APIRequestContext) inherits the authenticated
    // session cookie and works against a REMOTE browser; the `download`
    // event API assumes a local filesystem, which does not exist here.
    const context = await this.ensureContext();
    // `maxRedirects: 0` ("pass `0` to not follow redirects", playwright-core
    // 1.63 `APIRequestContext.get`) is what makes the SSRF guard in
    // `PlaywrightSuricataScraper.fetchAttachment` actually binding. That guard
    // only ever sees the INITIAL url; by default this call follows up to 20
    // redirects, so a same-origin attachment answering
    // `302 Location: http://<internal-host>/` would be chased here, with the
    // authenticated session, and the final hop's body persisted to MinIO as if
    // no guard existed.
    const response = await context.request.get(url, { maxRedirects: 0 });

    // Any 3xx is refused rather than followed. This adapter deliberately does
    // NOT try to re-validate the `Location` origin: it does not own the
    // baseUrl/origin policy (the scraper does), and Suricata attachments are
    // served directly. A legitimate redirect showing up here is a change in the
    // remote system that must be reviewed, not silently followed.
    const status = response.status();
    if (status >= 300 && status < 400) {
      await response.dispose();
      throw new SuricataAttachmentInvalidOriginError();
    }

    const headers = response.headers();

    // Enforce the ceiling on the DECLARED size FIRST. Checking only
    // `buffer.length` afterwards means a hostile or simply huge attachment is
    // fully resident in this process's heap before we decide to reject it —
    // the sidecar happily streams 2 GB and the BE container OOMs. Rejecting on
    // the header costs one round trip of headers and nothing else.
    const declaredLength = Number(headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > this.cfg.maxAttachmentBytes) {
      // Free the connection/response without reading it.
      await response.dispose();
      throw new SuricataAttachmentTooLargeError();
    }

    // RESIDUAL (accepted, documented): a response with NO `Content-Length`
    // (chunked transfer) cannot be pre-empted here — `APIResponse` has no
    // streaming/partial-read API, `body()` is all-or-nothing. Those fall
    // through to `SyncSuricataTickets`'s buffer-length check, which is the
    // behaviour that already existed. Full streaming with an early abort would
    // need a different transport than `context.request` (which is also what
    // carries the authenticated cookie), so it is deliberately out of scope
    // for this fix.
    const buffer = await response.body();
    const mimeType = headers['content-type'] ?? 'application/octet-stream';
    return { buffer, mimeType };
  }

  /**
   * suricata-bot-autonomous-actions (Phase D, task D.1, design D3.b, spec
   * NOTE-4/NOTE-7) — navigates to the ticket's OWN detail page (addressed
   * directly by `externalId`, B.5), re-confirms `ticketIdHiddenField` matches
   * `externalId` BEFORE ever touching the textarea (NOTE-7 — fails closed on
   * a stale/wrong page rather than posting on the wrong ticket), fills the
   * comment via `fill` (never `page.evaluate` with interpolation, Threat
   * Matrix), clicks the submit button, and detects success via the textarea
   * going back to empty — `#btnCreateNote` has no inline `onclick` to inspect
   * (B.5), so the textarea's own value is the one cheap, stable post-condition
   * marker available.
   */
  async postNote(externalId: string, text: string): Promise<void> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      const url = new URL(SURICATA_TICKET_DETAIL_PATH, this.cfg.baseUrl);
      url.searchParams.set('tick', externalId);
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });

      // NOTE-7 — re-confirm the loaded page is really this ticket's detail
      // page before submitting anything.
      const loadedTicketId = await page.locator(SURICATA_INTERNAL_NOTE_SELECTORS.ticketIdHiddenField).inputValue();
      if (loadedTicketId !== externalId) {
        throw new SuricataActionNotAppliedError(
          `Suricata internal-note detail page loaded ticket id "${loadedTicketId}", expected "${externalId}"`,
        );
      }

      // FIX 2026-09-14 (real rollout smoke test) — `commentTextarea` is in the
      // DOM on load but renders 0x0 until this tab is opened; `fill()` alone
      // times out waiting for visibility. Click it every time, never assume
      // the tab is already open.
      await page.locator(SURICATA_INTERNAL_NOTE_SELECTORS.notesTabLink).click();

      const textarea = page.locator(SURICATA_INTERNAL_NOTE_SELECTORS.commentTextarea);
      await textarea.fill(text);
      await page.locator(SURICATA_INTERNAL_NOTE_SELECTORS.submitButton).click();

      try {
        await page.waitForFunction(
          (selector: string) => {
            const el = document.querySelector(selector) as HTMLTextAreaElement | null;
            return el !== null && el.value === '';
          },
          SURICATA_INTERNAL_NOTE_SELECTORS.commentTextarea,
          { timeout: 5_000 },
        );
      } catch {
        throw new SuricataActionNotAppliedError();
      }
    } finally {
      await page.close();
    }
  }

  /**
   * suricata-bot-autonomous-actions (Phase E, task E.1, design D3.b, spec
   * STATUS-4/STATUS-7) — drives Suricata's list-page bulk "Cambiar Estado"
   * modal for the ONE ticket matching `externalId` (B.2/B.3 — no per-ticket
   * control exists, the bulk modal is the only path). B.6's auto-sync
   * toggle is clicked BEFORE selecting the row and AFTER acting (in
   * `finally`, best-effort) so a mid-flow 60s redraw never silently clears
   * the selection. `status` is matched by its visible LABEL text in
   * `#valorSelect` — the SAME literal `ChangeSuricataTicketStatus` already
   * validated against `SURICATA_STATUS_VALUES`, never re-derived here.
   */
  async changeTicketStatus(externalId: string, status: string): Promise<void> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      await page.goto(resolveUrl(this.cfg.baseUrl, SURICATA_ROUTES.TICKETS_LIST_PATH), { waitUntil: 'domcontentloaded' });

      // B.6 — stop the 60s auto-redraw BEFORE selecting a row; a mid-flow
      // redraw silently clears the checkbox otherwise (STATUS-7).
      await page.locator(SURICATA_BULK_ACTION_SELECTORS.autoSyncStopButton).click();

      const checkbox = page.locator(SURICATA_BULK_ACTION_SELECTORS.rowCheckbox(externalId));
      await checkbox.waitFor({ state: 'visible', timeout: 5_000 });
      await checkbox.check();

      // STATUS-7 — re-confirm the checkbox actually stayed checked before
      // opening the modal: a raced redraw that dropped the row would leave
      // it unchecked, and confirming on nothing/the wrong ticket is worse
      // than failing closed here.
      if (!(await checkbox.isChecked())) {
        throw new SuricataActionNotAppliedError(
          `Suricata status-change: row checkbox for ticket "${externalId}" did not stay checked`,
        );
      }

      await page.locator(SURICATA_BULK_ACTION_SELECTORS.changeStatusButton).click();
      const modal = page.locator(SURICATA_BULK_ACTION_SELECTORS.modal);
      await modal.waitFor({ state: 'visible', timeout: 5_000 });

      await page.locator(SURICATA_BULK_ACTION_SELECTORS.statusSelect).selectOption({ label: status });
      await page.locator(SURICATA_BULK_ACTION_SELECTORS.confirmButton).click();

      try {
        await modal.waitFor({ state: 'hidden', timeout: 5_000 });
      } catch {
        throw new SuricataActionNotAppliedError();
      }
    } finally {
      // B.6 — restore the auto-sync regardless of outcome; best-effort, a
      // failure here must never mask the real result of the action above.
      await page
        .locator(SURICATA_BULK_ACTION_SELECTORS.autoSyncStartButton)
        .click()
        .catch(() => {});
      await page.close();
    }
  }

  /**
   * suricata-bot-autonomous-actions (Phase F, task F.1, design D3.b/D5.a,
   * spec CLOSE-4/CLOSE-7) — drives Suricata's list-page bulk "Cerrar
   * seleccionados" modal for the ONE ticket matching `externalId` (B.2/B.3
   * — no per-ticket control exists, the bulk modal is the only path),
   * exactly like `changeTicketStatus` above but filling the free-text
   * close-reason field (`#descripcionCierre`) instead of selecting a status
   * option. `#motivoCierreSelect` is deliberately left at its default value
   * (no motivo classification) — the caller supplies one free-text
   * `reason`, which maps to the description field, not the two-value
   * motivo catalog (see `actionSelectors.ts`'s header comment on
   * `closeReasonSelect`). B.6's auto-sync toggle is clicked BEFORE
   * selecting the row and AFTER acting (in `finally`, best-effort) so a
   * mid-flow 60s redraw never silently clears the selection.
   */
  async closeTicket(externalId: string, reason: string): Promise<void> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      await page.goto(resolveUrl(this.cfg.baseUrl, SURICATA_ROUTES.TICKETS_LIST_PATH), { waitUntil: 'domcontentloaded' });

      // B.6 — stop the 60s auto-redraw BEFORE selecting a row; a mid-flow
      // redraw silently clears the checkbox otherwise (CLOSE-7).
      await page.locator(SURICATA_BULK_ACTION_SELECTORS.autoSyncStopButton).click();

      const checkbox = page.locator(SURICATA_BULK_ACTION_SELECTORS.rowCheckbox(externalId));
      await checkbox.waitFor({ state: 'visible', timeout: 5_000 });
      await checkbox.check();

      // CLOSE-7 — re-confirm the checkbox actually stayed checked before
      // opening the modal: a raced redraw that dropped the row would leave
      // it unchecked, and confirming on nothing/the wrong ticket is worse
      // than failing closed here.
      if (!(await checkbox.isChecked())) {
        throw new SuricataActionNotAppliedError(
          `Suricata close: row checkbox for ticket "${externalId}" did not stay checked`,
        );
      }

      await page.locator(SURICATA_BULK_ACTION_SELECTORS.closeButton).click();
      const modal = page.locator(SURICATA_BULK_ACTION_SELECTORS.modal);
      await modal.waitFor({ state: 'visible', timeout: 5_000 });

      await page.locator(SURICATA_BULK_ACTION_SELECTORS.closeDescriptionInput).fill(reason);
      await page.locator(SURICATA_BULK_ACTION_SELECTORS.confirmButton).click();

      try {
        await modal.waitFor({ state: 'hidden', timeout: 5_000 });
      } catch {
        throw new SuricataActionNotAppliedError();
      }
    } finally {
      // B.6 — restore the auto-sync regardless of outcome; best-effort, a
      // failure here must never mask the real result of the action above.
      await page
        .locator(SURICATA_BULK_ACTION_SELECTORS.autoSyncStartButton)
        .click()
        .catch(() => {});
      await page.close();
    }
  }
}

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
 * ⚠️ RISK — see `selectors.ts`'s `SURICATA_AUTH_SELECTORS`/`SURICATA_AUTH_PATHS`
 * doc comment: the login-form/authenticated-marker selectors are SYNTHETIC
 * placeholders, never contrasted against the real Suricata Cx login page (no
 * credentials/network access from this apply environment). Do not flip
 * `SURICATA_BROWSER_WS` in prod before the manual smoke test (D14 steps 2-4)
 * confirms these selectors against the real DOM.
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
import { SuricataAttachmentTooLargeError } from '@domain/errors/suricata';
import type { SuricataBrowserSession } from './PlaywrightSuricataScraper';
import { SURICATA_AUTH_SELECTORS, SURICATA_AUTH_PATHS } from './selectors';

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

export class PlaywrightBrowserSession implements SuricataBrowserSession {
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
      const loginFormCount = await page.locator(SURICATA_AUTH_SELECTORS.loginForm).count();
      return loginFormCount === 0;
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

  async fetchHtml(url: string): Promise<string> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return await page.content();
    } finally {
      await page.close();
    }
  }

  async fetchBinary(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
    // D5 — `context.request` (APIRequestContext) inherits the authenticated
    // session cookie and works against a REMOTE browser; the `download`
    // event API assumes a local filesystem, which does not exist here.
    const context = await this.ensureContext();
    const response = await context.request.get(url);
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
}

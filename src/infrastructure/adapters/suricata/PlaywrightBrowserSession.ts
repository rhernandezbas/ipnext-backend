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
 */
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import type { SuricataBrowserSession } from './PlaywrightSuricataScraper';
import { SURICATA_AUTH_SELECTORS, SURICATA_AUTH_PATHS } from './selectors';

export interface PlaywrightBrowserSessionConfig {
  /** ws:// endpoint of the Playwright `run-server` sidecar (D5). */
  browserWs: string;
  baseUrl: string;
  username: string;
  password: string;
}

function resolveUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

export class PlaywrightBrowserSession implements SuricataBrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private connecting: Promise<BrowserContext> | null = null;

  constructor(private readonly cfg: PlaywrightBrowserSessionConfig) {}

  /** Memoized: `chromium.connect` runs at most once per instance (see the test asserting `toHaveBeenCalledTimes(1)`). */
  private ensureContext(): Promise<BrowserContext> {
    if (this.context) return Promise.resolve(this.context);
    if (!this.connecting) this.connecting = this.connect();
    return this.connecting;
  }

  private async connect(): Promise<BrowserContext> {
    this.browser = await chromium.connect(this.cfg.browserWs);
    this.context = await this.browser.newContext();
    return this.context;
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
    const buffer = await response.body();
    const mimeType = response.headers()['content-type'] ?? 'application/octet-stream';
    return { buffer, mimeType };
  }
}

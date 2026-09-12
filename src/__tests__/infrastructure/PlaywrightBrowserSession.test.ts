/**
 * suricata-tickets-mirror (Phase J, task J.1/D5) — `PlaywrightBrowserSession`
 * is the ONLY file in the whole change that imports `playwright-core`
 * directly (`chromium.connect` against the sidecar's `run-server`). This
 * suite mocks `playwright-core` entirely (molde `jest.mock('axios')` in
 * `GestionRealClient.retry.test.ts`) — there is no real Suricata/sidecar
 * reachable from this environment, so every assertion is about OUR wiring
 * (which selector/path/method gets called, in what order, with what
 * fallback) never about the real Suricata DOM (see the risk disclaimer on
 * `selectors.ts`'s `SURICATA_AUTH_SELECTORS`).
 */
import { chromium } from 'playwright-core';
import { PlaywrightBrowserSession } from '@infrastructure/adapters/suricata/PlaywrightBrowserSession';
import { SURICATA_AUTH_SELECTORS, SURICATA_AUTH_PATHS } from '@infrastructure/adapters/suricata/selectors';
import { SuricataAttachmentTooLargeError } from '@domain/errors/suricata';

jest.mock('playwright-core', () => ({
  chromium: { connect: jest.fn() },
}));

interface FakeLocator {
  count: jest.Mock;
  fill: jest.Mock;
  click: jest.Mock;
}

function makeFakeLocator(overrides: Partial<FakeLocator> = {}): FakeLocator {
  return {
    count: jest.fn().mockResolvedValue(0),
    fill: jest.fn().mockResolvedValue(undefined),
    click: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeFakePage(opts: { loginFormCount?: number } = {}) {
  const locator = jest.fn((selector: string) => {
    if (selector === SURICATA_AUTH_SELECTORS.loginForm) {
      return makeFakeLocator({ count: jest.fn().mockResolvedValue(opts.loginFormCount ?? 0) });
    }
    return makeFakeLocator();
  });
  return {
    goto: jest.fn().mockResolvedValue(undefined),
    content: jest.fn().mockResolvedValue('<html>ok</html>'),
    locator,
    close: jest.fn().mockResolvedValue(undefined),
    waitForLoadState: jest.fn().mockResolvedValue(undefined),
  };
}

function makeFakeResponse(headers: Record<string, string> = { 'content-type': 'image/png' }) {
  return {
    body: jest.fn().mockResolvedValue(Buffer.from('IMG')),
    headers: jest.fn().mockReturnValue(headers),
    dispose: jest.fn().mockResolvedValue(undefined),
  };
}

function makeFakeContext(
  page: ReturnType<typeof makeFakePage>,
  response: ReturnType<typeof makeFakeResponse> = makeFakeResponse(),
) {
  return {
    newPage: jest.fn().mockResolvedValue(page),
    request: {
      get: jest.fn().mockResolvedValue(response),
    },
  };
}

describe('PlaywrightBrowserSession (Phase J, D5)', () => {
  const cfg = {
    browserWs: 'ws://playwright:3000/',
    baseUrl: 'https://suricata.example.com',
    username: 'bot-user',
    password: 'bot-pass',
    maxAttachmentBytes: 10 * 1024 * 1024,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('isAuthenticated navigates the cheap authenticated probe and reports true when no login form is present', async () => {
    const page = makeFakePage({ loginFormCount: 0 });
    const context = makeFakeContext(page);
    const browser = { newContext: jest.fn().mockResolvedValue(context) };
    (chromium.connect as jest.Mock).mockResolvedValue(browser);

    const session = new PlaywrightBrowserSession(cfg);
    const authenticated = await session.isAuthenticated();

    expect(authenticated).toBe(true);
    expect(chromium.connect).toHaveBeenCalledWith(cfg.browserWs);
    expect(page.goto).toHaveBeenCalledWith(
      `https://suricata.example.com${SURICATA_AUTH_PATHS.authenticatedProbe}`,
      { waitUntil: 'domcontentloaded' },
    );
    expect(page.close).toHaveBeenCalled();
  });

  it('isAuthenticated reports false when the login form marker IS present', async () => {
    const page = makeFakePage({ loginFormCount: 1 });
    const context = makeFakeContext(page);
    const browser = { newContext: jest.fn().mockResolvedValue(context) };
    (chromium.connect as jest.Mock).mockResolvedValue(browser);

    const session = new PlaywrightBrowserSession(cfg);
    const authenticated = await session.isAuthenticated();

    expect(authenticated).toBe(false);
  });

  it('login fills username/password and submits, using SURICATA_AUTH_SELECTORS', async () => {
    const usernameLocator = makeFakeLocator();
    const passwordLocator = makeFakeLocator();
    const submitLocator = makeFakeLocator();
    const page = makeFakePage();
    page.locator = jest.fn((selector: string) => {
      if (selector === SURICATA_AUTH_SELECTORS.usernameField) return usernameLocator;
      if (selector === SURICATA_AUTH_SELECTORS.passwordField) return passwordLocator;
      if (selector === SURICATA_AUTH_SELECTORS.submitButton) return submitLocator;
      return makeFakeLocator();
    });
    const context = makeFakeContext(page);
    const browser = { newContext: jest.fn().mockResolvedValue(context) };
    (chromium.connect as jest.Mock).mockResolvedValue(browser);

    const session = new PlaywrightBrowserSession(cfg);
    await session.login();

    expect(page.goto).toHaveBeenCalledWith(
      `https://suricata.example.com${SURICATA_AUTH_PATHS.loginPath}`,
      { waitUntil: 'domcontentloaded' },
    );
    expect(usernameLocator.fill).toHaveBeenCalledWith(cfg.username);
    expect(passwordLocator.fill).toHaveBeenCalledWith(cfg.password);
    expect(submitLocator.click).toHaveBeenCalled();
  });

  it('login swallows a raw Playwright failure (e.g. a selector that never resolves) instead of throwing — the typed SuricataAuthError is ensureAuthenticated`s job, not this adapter`s', async () => {
    const page = makeFakePage();
    page.locator = jest.fn((_selector: string) => {
      throw new Error('Timeout 30000ms exceeded waiting for selector');
    });
    const context = makeFakeContext(page);
    const browser = { newContext: jest.fn().mockResolvedValue(context) };
    (chromium.connect as jest.Mock).mockResolvedValue(browser);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const session = new PlaywrightBrowserSession(cfg);
    await expect(session.login()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('fetchHtml navigates the given URL and returns page.content()', async () => {
    const page = makeFakePage();
    const context = makeFakeContext(page);
    const browser = { newContext: jest.fn().mockResolvedValue(context) };
    (chromium.connect as jest.Mock).mockResolvedValue(browser);

    const session = new PlaywrightBrowserSession(cfg);
    const html = await session.fetchHtml('https://suricata.example.com/tickets/1001');

    expect(page.goto).toHaveBeenCalledWith('https://suricata.example.com/tickets/1001', {
      waitUntil: 'domcontentloaded',
    });
    expect(html).toBe('<html>ok</html>');
  });

  it('fetchBinary uses context.request.get (inherits the session cookie, works against a remote browser) and returns the body + content-type', async () => {
    const page = makeFakePage();
    const context = makeFakeContext(page);
    const browser = { newContext: jest.fn().mockResolvedValue(context) };
    (chromium.connect as jest.Mock).mockResolvedValue(browser);

    const session = new PlaywrightBrowserSession(cfg);
    const result = await session.fetchBinary('https://suricata.example.com/attachments/1.png');

    expect(context.request.get).toHaveBeenCalledWith('https://suricata.example.com/attachments/1.png');
    expect(result).toEqual({ buffer: Buffer.from('IMG'), mimeType: 'image/png' });
  });

  describe('attachment size ceiling is enforced BEFORE the body is materialized', () => {
    it('a Content-Length over the ceiling aborts without ever calling response.body()', async () => {
      const page = makeFakePage();
      const response = makeFakeResponse({ 'content-type': 'application/octet-stream', 'content-length': '99999999' });
      const context = makeFakeContext(page, response);
      const browser = { newContext: jest.fn().mockResolvedValue(context) };
      (chromium.connect as jest.Mock).mockResolvedValue(browser);

      const session = new PlaywrightBrowserSession({ ...cfg, maxAttachmentBytes: 1024 });

      await expect(session.fetchBinary('https://suricata.example.com/big.bin')).rejects.toThrow(
        SuricataAttachmentTooLargeError,
      );
      // The whole point: the 99MB never lands in this process's heap.
      expect(response.body).not.toHaveBeenCalled();
      expect(response.dispose).toHaveBeenCalled();
    });

    it('the rejection message is exactly `too_large`, matching the existing lastError convention', async () => {
      const page = makeFakePage();
      const response = makeFakeResponse({ 'content-length': '5000' });
      const context = makeFakeContext(page, response);
      const browser = { newContext: jest.fn().mockResolvedValue(context) };
      (chromium.connect as jest.Mock).mockResolvedValue(browser);

      const session = new PlaywrightBrowserSession({ ...cfg, maxAttachmentBytes: 100 });

      let thrown: unknown;
      try {
        await session.fetchBinary('https://suricata.example.com/big.bin');
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error).message).toBe('too_large');
    });

    it('a Content-Length within the ceiling proceeds normally', async () => {
      const page = makeFakePage();
      const response = makeFakeResponse({ 'content-type': 'image/png', 'content-length': '3' });
      const context = makeFakeContext(page, response);
      const browser = { newContext: jest.fn().mockResolvedValue(context) };
      (chromium.connect as jest.Mock).mockResolvedValue(browser);

      const session = new PlaywrightBrowserSession({ ...cfg, maxAttachmentBytes: 1024 });
      const result = await session.fetchBinary('https://suricata.example.com/small.png');

      expect(result).toEqual({ buffer: Buffer.from('IMG'), mimeType: 'image/png' });
      expect(response.body).toHaveBeenCalled();
    });

    it('RESIDUAL — no Content-Length header: the body IS materialized, and the SyncSuricataTickets post-check stays the backstop', async () => {
      const page = makeFakePage();
      const response = makeFakeResponse({ 'content-type': 'image/png' }); // no content-length
      const context = makeFakeContext(page, response);
      const browser = { newContext: jest.fn().mockResolvedValue(context) };
      (chromium.connect as jest.Mock).mockResolvedValue(browser);

      const session = new PlaywrightBrowserSession({ ...cfg, maxAttachmentBytes: 1 });
      const result = await session.fetchBinary('https://suricata.example.com/unknown-size.png');

      // Documented, deliberate: this adapter cannot pre-empt what the server
      // does not declare. The 3-byte body comes back even though the ceiling
      // is 1 byte, and `SyncSuricataTickets` rejects it by buffer length.
      expect(result.buffer).toEqual(Buffer.from('IMG'));
      expect(response.body).toHaveBeenCalled();
    });

    it('a garbage Content-Length is ignored rather than trusted (falls through to the backstop)', async () => {
      const page = makeFakePage();
      const response = makeFakeResponse({ 'content-type': 'image/png', 'content-length': 'not-a-number' });
      const context = makeFakeContext(page, response);
      const browser = { newContext: jest.fn().mockResolvedValue(context) };
      (chromium.connect as jest.Mock).mockResolvedValue(browser);

      const session = new PlaywrightBrowserSession({ ...cfg, maxAttachmentBytes: 1024 });
      await expect(session.fetchBinary('https://suricata.example.com/x.png')).resolves.toBeTruthy();
    });
  });

  it('connects to the sidecar via chromium.connect ONLY ONCE across multiple calls (lazy, memoized context)', async () => {
    const page = makeFakePage();
    const context = makeFakeContext(page);
    const browser = { newContext: jest.fn().mockResolvedValue(context) };
    (chromium.connect as jest.Mock).mockResolvedValue(browser);

    const session = new PlaywrightBrowserSession(cfg);
    await session.isAuthenticated();
    await session.fetchHtml('https://suricata.example.com/tickets');

    expect(chromium.connect).toHaveBeenCalledTimes(1);
  });
});

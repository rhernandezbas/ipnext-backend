/**
 * suricata-tickets-mirror (Phase J, task J.1/D5/D11/D14) — Phase C left
 * `bootstrapSuricataSync` returning `null` UNCONDITIONALLY (no real driver
 * existed yet). This phase completes the second branch: `SURICATA_BASE_URL`
 * AND `SURICATA_BROWSER_WS` both set ⇒ a real `SuricataSyncScheduler` is
 * constructed and returned, wired with the real Playwright-backed session.
 *
 * Molde `bootstrapFinanceReceiptsIngest.test.ts` (RF9): boots the REAL object
 * graph via `jest.resetModules()` + fresh dynamic imports, so `toBeInstanceOf`
 * compares against the SAME module registry the bootstrap itself loaded.
 * `chromium.connect` is mocked (same as `PlaywrightBrowserSession.test.ts`)
 * so this suite never attempts a real network/WebSocket call — the whole
 * point of D5's "vacío ⇒ feature apagada, sin tirar al boot" is that
 * construction itself does NO I/O.
 */
jest.mock('playwright-core', () => ({
  chromium: { connect: jest.fn() },
}));

describe('bootstrapSuricataSync (Phase J — real Playwright wiring)', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  const REQUIRED_ENV = {
    SPLYNX_API_URL: 'http://x',
    SPLYNX_API_KEY: 'k',
    SPLYNX_API_SECRET: 's',
    JWT_SECRET: 'j',
    PORT: '3000',
  };

  async function bootstrapWith(env: Record<string, string | undefined>) {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ...env };
    const mod = await import('@infrastructure/scheduling/bootstrapSuricataSync');
    const { SuricataSyncScheduler } = await import('@infrastructure/scheduling/SuricataSyncScheduler');
    const { PlaywrightBrowserSession } = await import('@infrastructure/adapters/suricata/PlaywrightBrowserSession');
    return { scheduler: await mod.bootstrapSuricataSync(), SuricataSyncScheduler, PlaywrightBrowserSession };
  }

  it('still returns null when SURICATA_BASE_URL is unset (Phase C behavior preserved)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { scheduler } = await bootstrapWith({ ...REQUIRED_ENV, SURICATA_BROWSER_WS: 'ws://playwright:3000/' });
    warnSpy.mockRestore();

    expect(scheduler).toBeNull();
  });

  it('still returns null when SURICATA_BROWSER_WS is unset (Phase C behavior preserved)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { scheduler } = await bootstrapWith({ ...REQUIRED_ENV, SURICATA_BASE_URL: 'https://suricata.example.com' });
    warnSpy.mockRestore();

    expect(scheduler).toBeNull();
  });

  it('returns a REAL SuricataSyncScheduler when both SURICATA_BASE_URL and SURICATA_BROWSER_WS are set — no network call is made during construction', async () => {
    const { chromium } = await import('playwright-core');
    const { scheduler, SuricataSyncScheduler } = await bootstrapWith({
      ...REQUIRED_ENV,
      SURICATA_BASE_URL: 'https://suricata.example.com',
      SURICATA_BROWSER_WS: 'ws://playwright:3000/',
      SURICATA_USER: 'bot',
      SURICATA_PASSWORD: 'secret',
    });

    expect(scheduler).toBeInstanceOf(SuricataSyncScheduler);
    // D5 — construction is fully offline; `chromium.connect` only happens
    // lazily inside a scraper call during an actual sync tick.
    expect((chromium.connect as jest.Mock)).not.toHaveBeenCalled();
  });
});

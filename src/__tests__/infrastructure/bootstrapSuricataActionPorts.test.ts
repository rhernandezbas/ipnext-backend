/**
 * suricata-bot-autonomous-actions (Phase D, task D.4) — Phase A left
 * `bootstrapSuricataActionPorts` returning all four ports `null`
 * UNCONDITIONALLY (no driver existed yet). This phase completes the `note`
 * branch: both sidecar envs set ⇒ a real `PlaywrightSuricataInternalNote` is
 * constructed and registered; `reply`/`close`/`status` stay `null` (reply is
 * a plain HTTP adapter wired directly in `app.ts`, close/status are blocked
 * on Phases E/F's own driver tasks).
 *
 * Molde `bootstrapSuricataSync.test.ts`: boots the REAL object graph via
 * `jest.resetModules()` + fresh dynamic imports so `toBeInstanceOf` compares
 * against the SAME module registry the bootstrap itself loaded.
 * `chromium.connect` is mocked so this suite never attempts a real
 * network/WebSocket call — construction itself does no I/O (D5's own
 * "vacío ⇒ apagada, sin tirar al boot" philosophy, same as the sync lane).
 */
jest.mock('playwright-core', () => ({
  chromium: { connect: jest.fn() },
}));

describe('bootstrapSuricataActionPorts (Phase D — real note driver)', () => {
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
    const mod = await import('@infrastructure/adapters/suricata/bootstrapSuricataActionPorts');
    const registry = await import('@infrastructure/adapters/suricata/suricataActionPortsRegistry');
    const { PlaywrightSuricataInternalNote } = await import('@infrastructure/adapters/suricata/PlaywrightSuricataInternalNote');
    const ports = mod.bootstrapSuricataActionPorts();
    return { ports, registry, PlaywrightSuricataInternalNote };
  }

  it('returns all four ports null when SURICATA_BASE_URL is unset', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { ports } = await bootstrapWith({ ...REQUIRED_ENV, SURICATA_BROWSER_WS: 'ws://playwright:3000/' });
    warnSpy.mockRestore();

    expect(ports).toEqual({ reply: null, close: null, status: null, note: null });
  });

  it('returns all four ports null when SURICATA_BROWSER_WS is unset', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { ports } = await bootstrapWith({ ...REQUIRED_ENV, SURICATA_BASE_URL: 'https://suricata.example.com' });
    warnSpy.mockRestore();

    expect(ports).toEqual({ reply: null, close: null, status: null, note: null });
  });

  it('constructs a REAL PlaywrightSuricataInternalNote when both envs are set — reply/close/status stay null, no network call during construction', async () => {
    const { chromium } = await import('playwright-core');
    const { ports, PlaywrightSuricataInternalNote } = await bootstrapWith({
      ...REQUIRED_ENV,
      SURICATA_BASE_URL: 'https://suricata.example.com',
      SURICATA_BROWSER_WS: 'ws://playwright:3000/',
      SURICATA_USER: 'bot',
      SURICATA_PASSWORD: 'secret',
    });

    expect(ports.note).toBeInstanceOf(PlaywrightSuricataInternalNote);
    expect(ports.reply).toBeNull();
    expect(ports.close).toBeNull();
    expect(ports.status).toBeNull();
    expect((chromium.connect as jest.Mock)).not.toHaveBeenCalled();
  });

  it('registers the SAME note instance in suricataActionPortsRegistry.ts', async () => {
    const { ports, registry } = await bootstrapWith({
      ...REQUIRED_ENV,
      SURICATA_BASE_URL: 'https://suricata.example.com',
      SURICATA_BROWSER_WS: 'ws://playwright:3000/',
      SURICATA_USER: 'bot',
      SURICATA_PASSWORD: 'secret',
    });

    expect(registry.getSuricataBotNotePort()).toBe(ports.note);
  });
});

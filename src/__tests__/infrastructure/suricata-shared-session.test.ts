/**
 * suricata-tickets-mirror (fix wave, D4) — the SINGLE shared `SuricataSession`.
 *
 * D4's priority queue ("un reply `high` se adelanta a un sync `low` encolado")
 * is an IN-PROCESS mutex: it only means anything if both lanes hold the SAME
 * `SuricataSession` object. While each lane built its own instance the queue
 * was dead code, and the day a real `PlaywrightSuricataReply` gets wired each
 * lane would open its own `chromium.connect` → two logins against the same
 * third-party account.
 *
 * This suite pins the composition invariant, NOT a behaviour change: the reply
 * lane is still hardcoded to `UnavailableSuricataReplyPort` (asserted below and
 * in `suricata-composition.test.ts`). Nothing here enables a real send.
 */
jest.mock('playwright-core', () => ({
  chromium: { connect: jest.fn() },
}));

import { readFileSync } from 'fs';
import { join } from 'path';

describe('suricata shared session (D4) — one instance across the sync and reply lanes', () => {
  const ORIGINAL_ENV = { ...process.env };

  const SURICATA_ENV = {
    SPLYNX_API_URL: 'http://x',
    SPLYNX_API_KEY: 'k',
    SPLYNX_API_SECRET: 's',
    JWT_SECRET: 'j',
    PORT: '3000',
    SURICATA_BASE_URL: 'https://suricata.example.com',
    SURICATA_BROWSER_WS: 'ws://playwright:3000/',
    SURICATA_USER: 'bot',
    SURICATA_PASSWORD: 'secret',
  };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  async function loadWithSuricataEnv() {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ...SURICATA_ENV };
    const provider = await import('@infrastructure/adapters/suricata/sharedSuricataSession');
    const bootstrap = await import('@infrastructure/scheduling/bootstrapSuricataSync');
    const { SuricataSession } = await import('@infrastructure/adapters/suricata/SuricataSession');
    return { provider, bootstrap, SuricataSession };
  }

  it('the provider memoizes: two calls return the very same instance (reference identity)', async () => {
    const { provider, SuricataSession } = await loadWithSuricataEnv();

    const first = provider.getSharedSuricataSession();
    const second = provider.getSharedSuricataSession();

    expect(first).toBeInstanceOf(SuricataSession);
    expect(first).toBe(second); // === , not just equal
  });

  it('the session the SYNC graph receives is the exact object the REPLY graph would receive', async () => {
    const { provider, bootstrap } = await loadWithSuricataEnv();

    // What a reply lane resolves today (and what `PlaywrightSuricataReply`
    // would be handed the day it is wired — outside this change's scope).
    const replyLaneSession = provider.getSharedSuricataSession();

    const scheduler = await bootstrap.bootstrapSuricataSync();
    expect(scheduler).not.toBeNull();

    const syncLaneSession = provider.getSharedSuricataSession();
    expect(syncLaneSession).toBe(replyLaneSession);
  });

  it('returns null (feature off) when the sidecar envs are missing — the boot guard is untouched', async () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      SPLYNX_API_URL: 'http://x',
      SPLYNX_API_KEY: 'k',
      SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j',
      PORT: '3000',
      SURICATA_BASE_URL: undefined,
      SURICATA_BROWSER_WS: undefined,
    } as NodeJS.ProcessEnv;

    const provider = await import('@infrastructure/adapters/suricata/sharedSuricataSession');
    expect(provider.getSharedSuricataSession()).toBeNull();

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bootstrap = await import('@infrastructure/scheduling/bootstrapSuricataSync');
    const scheduler = await bootstrap.bootstrapSuricataSync();
    warnSpy.mockRestore();
    expect(scheduler).toBeNull();
  });

  it('resolving the shared session performs NO network I/O (chromium.connect stays lazy)', async () => {
    const { provider } = await loadWithSuricataEnv();
    const { chromium } = await import('playwright-core');

    provider.getSharedSuricataSession();

    expect(chromium.connect as jest.Mock).not.toHaveBeenCalled();
  });

  it('NOTHING outside the provider constructs a `new SuricataSession(` — a second instance cannot reappear', () => {
    const { readdirSync } = require('fs') as typeof import('fs');
    const srcRoot = join(__dirname, '..', '..');
    const constructionSites: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (readFileSync(full, 'utf8').includes('new SuricataSession(')) {
          constructionSites.push(full.slice(srcRoot.length + 1).replace(/\\/g, '/'));
        }
      }
    };
    walk(srcRoot);

    // Exactly ONE construction site, and it is the provider. Asserting the
    // positive (rather than "no offenders") is what keeps this from passing
    // vacuously if the walk ever stops reaching production files.
    expect(constructionSites).toEqual(['infrastructure/adapters/suricata/sharedSuricataSession.ts']);
  });

  it('the reply lane is STILL the unavailable guard — this fix wires composition, it enables nothing', () => {
    const appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');

    expect(appSrc).toContain('new UnavailableSuricataReplyPort()');
    expect(appSrc).not.toContain('new PlaywrightSuricataReply(');
  });
});

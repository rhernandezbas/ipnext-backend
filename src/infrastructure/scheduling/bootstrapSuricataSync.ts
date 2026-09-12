/**
 * bootstrapSuricataSync (suricata-tickets-mirror, Phase C, task C.10, D5/D11/D14)
 * — composition root for the Suricata Cx ticket mirror sync scheduler.
 *
 * Returns null when `SURICATA_BASE_URL` or `SURICATA_BROWSER_WS` is unset
 * (D5/D11 opt-in, molde `bootstrapChatMediaDownload`): the scheduler NEVER
 * starts and no network call to Suricata is ever attempted. The real ON/OFF
 * switch in prod is the `suricata-sync-enabled` feature flag (dark by
 * default, D14 "Deploy DARK") — this bootstrap is a SEPARATE, stricter gate
 * that also requires the actual sidecar/credentials to exist.
 *
 * DEVIATION (documented, pending Phase J): `playwright-core` is not a
 * dependency yet (task J.1 pins it exact, in its own isolated PR per D5), so
 * there is no real `SuricataBrowserSession` implementation to hand to
 * `SuricataSession`/`PlaywrightSuricataScraper` (both fully implemented and
 * unit-tested in this phase — see `PlaywrightSuricataScraper.test.ts`). If
 * `SURICATA_BROWSER_WS` is ever set before Phase J lands, this bootstrap logs
 * a clear warning and disables the scheduler rather than constructing a
 * scraper that could never actually reach Suricata — Phase J replaces the
 * single branch below with the real construction once the driver exists.
 */
import { config } from '../config';
import type { SuricataSyncScheduler } from './SuricataSyncScheduler';

export async function bootstrapSuricataSync(
  intervalMs = config.suricata.syncIntervalMs,
): Promise<SuricataSyncScheduler | null> {
  const { baseUrl, browserWs } = config.suricata;

  if (!baseUrl || !browserWs) {
    console.warn('[suricata-sync] SURICATA_BASE_URL/SURICATA_BROWSER_WS missing -- scheduler disabled');
    return null;
  }

  // Reachable only once BOTH envs are set. Until Phase J lands the real
  // `SuricataBrowserSession` (chromium.connect against the sidecar), there is
  // nothing safe to construct here -- fail loudly-but-gracefully instead of
  // starting a scheduler whose every tick would throw.
  console.warn(
    '[suricata-sync] SURICATA_BROWSER_WS is set but the Playwright session driver ' +
      '(Phase J) is not wired yet -- scheduler disabled',
  );
  void intervalMs;
  return null;
}

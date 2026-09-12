/**
 * sharedSuricataSession (suricata-tickets-mirror, fix wave, D4) — the SINGLE
 * process-wide `SuricataSession`, shared by the sync lane (priority `low`) and
 * the reply lane (priority `high`).
 *
 * Why a provider instead of each lane building its own:
 *
 *   D4's whole point is a priority queue where a `high` reply jumps ahead of a
 *   queued `low` sync tick. That queue lives INSIDE one `SuricataSession`
 *   object (`acquireInProcess`/`enqueue`). Two instances = two independent
 *   queues = the priority rule never fires, and the `PgAdvisoryLock` underneath
 *   cannot substitute for it: it is re-entrant within one pg session, so it
 *   does not serialize two callers in the SAME container (see
 *   `SuricataSession`'s own doc comment). On top of that, each instance owns
 *   its own `PlaywrightBrowserSession`, so the day a real
 *   `PlaywrightSuricataReply` is wired, two instances would mean two
 *   `chromium.connect` calls and two logins against the same Suricata account.
 *
 * Memoized, lazy, and I/O-free: building this touches no network — the
 * `PlaywrightBrowserSession` underneath only calls `chromium.connect` on its
 * first real use (D5 "vacío ⇒ feature apagada, sin tirar al boot").
 *
 * Returns `null` when `SURICATA_BASE_URL` or `SURICATA_BROWSER_WS` is unset:
 * the opt-in gate stays exactly where it was, this just moves the single
 * construction site out of `bootstrapSuricataSync`.
 *
 * NOTE (scope): the reply lane is still hardcoded to
 * `UnavailableSuricataReplyPort` in `app.ts`. This module is composition
 * infrastructure only — it enables no send.
 */
import { config } from '../../config';
import { PgAdvisoryLock } from '../pg/PgAdvisoryLock';
import { PlaywrightBrowserSession } from './PlaywrightBrowserSession';
import { SuricataSession } from './SuricataSession';

let shared: SuricataSession<PlaywrightBrowserSession> | null = null;
let resolved = false;

/**
 * The one `SuricataSession` every lane must use. `null` when the Suricata
 * sidecar envs are not configured (feature off).
 */
export function getSharedSuricataSession(): SuricataSession<PlaywrightBrowserSession> | null {
  if (resolved) return shared;

  const { baseUrl, browserWs, user, password } = config.suricata;
  resolved = true;

  if (!baseUrl || !browserWs) {
    shared = null;
    return shared;
  }

  const browserSession = new PlaywrightBrowserSession({ browserWs, baseUrl, username: user, password });
  shared = new SuricataSession(browserSession, new PgAdvisoryLock());
  return shared;
}

/**
 * Drops the memoized instance. Only for tests that re-resolve `config` under a
 * different env (`jest.resetModules()` already gives a fresh module registry,
 * so this is a belt-and-braces escape hatch, never used in production code).
 */
export function resetSharedSuricataSessionForTests(): void {
  shared = null;
  resolved = false;
}

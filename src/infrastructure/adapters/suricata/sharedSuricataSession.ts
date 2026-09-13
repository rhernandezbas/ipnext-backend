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
 * NOTE (scope, UPDATED Phase G): the reply lane no longer needs a Playwright
 * driver at all (design D3.b CORRECTED 2026-09-13) — it is a plain HTTP
 * adapter (`BotpressReplyAdapter`) that reuses `session.fetchJson` WITHOUT
 * the mutex (see `getSharedSuricataBrowserSession` below). This module is
 * still composition infrastructure only — it enables no send by itself.
 */
import { config } from '../../config';
import { PgAdvisoryLock } from '../pg/PgAdvisoryLock';
import { PlaywrightBrowserSession } from './PlaywrightBrowserSession';
import { SuricataSession } from './SuricataSession';

let sharedBrowserSession: PlaywrightBrowserSession | null = null;
let shared: SuricataSession<PlaywrightBrowserSession> | null = null;
let resolved = false;

function resolveSharedSuricataSession(): void {
  if (resolved) return;
  resolved = true;

  const { baseUrl, browserWs, user, password, maxAttachmentBytes } = config.suricata;
  if (!baseUrl || !browserWs) {
    sharedBrowserSession = null;
    shared = null;
    return;
  }

  sharedBrowserSession = new PlaywrightBrowserSession({
    browserWs,
    baseUrl,
    username: user,
    password,
    maxAttachmentBytes,
  });
  shared = new SuricataSession(sharedBrowserSession, new PgAdvisoryLock());
}

/**
 * The one `SuricataSession` every mutex-serialized lane must use. `null`
 * when the Suricata sidecar envs are not configured (feature off).
 */
export function getSharedSuricataSession(): SuricataSession<PlaywrightBrowserSession> | null {
  resolveSharedSuricataSession();
  return shared;
}

/**
 * suricata-bot-autonomous-actions (Phase G, task G.1/G.6, design D3.b
 * CORRECTED 2026-09-13) — the RAW session underneath the shared
 * `SuricataSession` mutex, for `BotpressReplyAdapter` ONLY. Reply never
 * touches DOM state (no `page.goto`, no `fill`/`click`) — it only calls
 * `fetchJson` against hosts entirely unrelated to Suricata's own
 * authenticated cookie (`backend.suricata.chat`/`api.botpress.cloud`), so
 * going through the mutex/priority queue would make it wait behind
 * completely unrelated DOM work for no isolation benefit (D3.b).
 *
 * Returns the SAME instance `getSharedSuricataSession()` wraps — NEVER a
 * second `PlaywrightBrowserSession`: a second instance would mean a second
 * `chromium.connect` call and a second login against the same Suricata
 * account, exactly the hazard this module's own header comment warns
 * against for the sync/reply split. `null` under the identical opt-in gate.
 */
export function getSharedSuricataBrowserSession(): PlaywrightBrowserSession | null {
  resolveSharedSuricataSession();
  return sharedBrowserSession;
}

/**
 * Drops the memoized instance(s). Only for tests that re-resolve `config` under a
 * different env (`jest.resetModules()` already gives a fresh module registry,
 * so this is a belt-and-braces escape hatch, never used in production code).
 */
export function resetSharedSuricataSessionForTests(): void {
  sharedBrowserSession = null;
  shared = null;
  resolved = false;
}

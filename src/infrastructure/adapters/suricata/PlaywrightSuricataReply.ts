/**
 * suricata-tickets-mirror (Phase E, task E.1, D0/D3) — the ONLY adapter that
 * actually SENDS a reply into a real Suricata conversation. Molde
 * `PlaywrightSuricataScraper` (Phase C): acquires the shared session per call
 * (D0/D3.c) and releases it once `sendMessage` resolves.
 *
 * ⚠️ NOT wired anywhere in `composeSuricataModule` yet (Phase J scope, D5) —
 * `playwright-core` is not a dependency, so `SuricataReplySession` is a
 * narrow structural interface, same pattern Phase B/C already established
 * for `SuricataAuthSession`/`SuricataBrowserSession`. Until Phase J lands the
 * real driver, `composeSuricataModule` wires `UnavailableSuricataReplyPort`
 * INSTEAD of this class — see that file for the conservative guard.
 *
 * Threat Matrix (design.md) — the text is sent via `fill`/`type`, NEVER via
 * `page.evaluate` with string interpolation: `SuricataReplySession.sendMessage`
 * is the one seam a real implementation must respect, so the literal text
 * always reaches Suricata unmodified.
 */
import type { SuricataReplyPort } from '@domain/ports/SuricataReplyPort';
import { SuricataSession, type SuricataAuthSession } from './SuricataSession';

/**
 * Narrow structural contract `PlaywrightSuricataReply` needs on top of
 * `SuricataAuthSession`. Phase J's real implementation backs `sendMessage`
 * with `page.goto` to the ticket, then `locator.fill`/`locator.type` on the
 * reply box and a submit click — never `page.evaluate` with interpolated
 * text (Threat Matrix).
 */
export interface SuricataReplySession extends SuricataAuthSession {
  /** Navigates to the ticket's conversation and sends `body` verbatim. */
  sendMessage(externalId: string, body: string): Promise<void>;
}

export interface PlaywrightSuricataReplyConfig {
  /** D4 — the reply lane always requests the session at 'high' priority. */
  sessionTimeoutMs: number;
}

export class PlaywrightSuricataReply implements SuricataReplyPort {
  constructor(
    private readonly session: SuricataSession<SuricataReplySession>,
    private readonly cfg: PlaywrightSuricataReplyConfig,
  ) {}

  async sendReply(externalId: string, body: string): Promise<void> {
    await this.session.withSession({ priority: 'high', timeoutMs: this.cfg.sessionTimeoutMs }, async (s) => {
      await s.sendMessage(externalId, body);
    });
  }
}

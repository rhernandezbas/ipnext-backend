/**
 * suricata-bot-autonomous-actions (Phase F, task F.1, design D3.b, spec
 * suricata-ticket-close CLOSE-4/CLOSE-7) — the adapter that closes a ticket
 * via Suricata's real "Cerrar seleccionados" bulk-action modal. Molde
 * `PlaywrightSuricataStatus.ts` line for line: a narrow structural session
 * interface extending `SuricataAuthSession`, a `sessionTimeoutMs` config,
 * and a single `this.session.withSession({ priority: 'high', timeoutMs },
 * ...)` call — the close lane must never starve behind a 15-minute `low`
 * priority sync tick (same reasoning as note/status/reply).
 *
 * CLOSE-7 — auto-sync handling: exactly like status, close acts on the LIST
 * page's bulk-selection modal (B.2/B.3 — no per-ticket control exists),
 * which IS vulnerable to a mid-flow 60s auto-redraw clearing the checkbox
 * (B.6). The real implementation of `closeTicket` clicks the "Detener"
 * toggle BEFORE selecting the row and "Iniciar" after acting, and
 * re-confirms the checkbox actually stayed checked before opening the
 * modal, failing closed (`SuricataActionNotAppliedError`) rather than
 * confirming on a stale/wrong selection.
 *
 * Design D5.a (corrected 2026-09-13) — closing is its OWN Suricata action,
 * independent from "Cambiar Estado". This port never touches
 * `SuricataTicket.status` (the use case, `CloseSuricataTicket`, owns that
 * decision — the driver itself is unaware of the mirror entirely, exactly
 * like every other `PlaywrightSuricata*` driver).
 */
import type { SuricataTicketClosePort } from '@domain/ports/SuricataTicketClosePort';
import { SuricataSession, type SuricataAuthSession } from './SuricataSession';

/**
 * Narrow structural contract `PlaywrightSuricataClose` needs on top of
 * `SuricataAuthSession`. The real implementation navigates to the tickets
 * list page, stops the auto-sync toggle, selects the ONE row matching
 * `externalId`, opens the "Cerrar seleccionados" modal, fills the free-text
 * close reason, confirms, and detects success via the modal closing —
 * never `page.evaluate` with interpolated text (Threat Matrix).
 */
export interface SuricataCloseSession extends SuricataAuthSession {
  /** Drives Suricata's list-page bulk "Cerrar seleccionados" modal for the ONE ticket identified by `externalId`. */
  closeTicket(externalId: string, reason: string): Promise<void>;
}

export interface PlaywrightSuricataCloseConfig {
  /** D3 — the close lane, like the other three autonomous actions, always requests the session at 'high' priority. */
  sessionTimeoutMs: number;
}

export class PlaywrightSuricataClose implements SuricataTicketClosePort {
  constructor(
    private readonly session: SuricataSession<SuricataCloseSession>,
    private readonly cfg: PlaywrightSuricataCloseConfig,
  ) {}

  async close(externalId: string, reason: string): Promise<void> {
    await this.session.withSession({ priority: 'high', timeoutMs: this.cfg.sessionTimeoutMs }, async (s) => {
      await s.closeTicket(externalId, reason);
    });
  }
}

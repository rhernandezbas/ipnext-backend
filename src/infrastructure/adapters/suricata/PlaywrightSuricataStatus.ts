/**
 * suricata-bot-autonomous-actions (Phase E, task E.1, design D3.b, spec
 * suricata-ticket-status STATUS-4/STATUS-7) — the adapter that changes a
 * ticket's status via Suricata's real "Cambiar Estado" bulk-action modal.
 * Molde `PlaywrightSuricataInternalNote.ts` line for line: a narrow
 * structural session interface extending `SuricataAuthSession`, a
 * `sessionTimeoutMs` config, and a single `this.session.withSession({
 * priority: 'high', timeoutMs }, ...)` call — the status lane must never
 * starve behind a 15-minute `low` priority sync tick (same reasoning as
 * note/reply).
 *
 * STATUS-7 — auto-sync handling: unlike note (which acts on the ticket's OWN
 * detail page), status acts on the LIST page's bulk-selection modal (B.2/B.3
 * — no per-ticket control exists), which IS vulnerable to a mid-flow 60s
 * auto-redraw clearing the checkbox (B.6). The real implementation of
 * `changeTicketStatus` clicks the "Detener" toggle BEFORE selecting the row
 * and "Iniciar" after acting, and re-confirms the checkbox actually stayed
 * checked before opening the modal, failing closed
 * (`SuricataActionNotAppliedError`) rather than confirming on a stale/wrong
 * selection.
 *
 * Threat Matrix (design.md, "Selector injection (new)") — `status` MUST be
 * validated against `SURICATA_STATUS_VALUES` (`isSuricataStatusValue`) BEFORE
 * it ever reaches this port; this port itself never validates it, exactly
 * like `PlaywrightSuricataReply` never validates `body` — the guard lives at
 * the use case/route layer (`ChangeSuricataTicketStatus`/
 * `composeSuricataExternalModule.ts`), not the driver.
 */
import type { SuricataTicketStatusPort } from '@domain/ports/SuricataTicketStatusPort';
import { SuricataSession, type SuricataAuthSession } from './SuricataSession';

/**
 * Narrow structural contract `PlaywrightSuricataStatus` needs on top of
 * `SuricataAuthSession`. The real implementation navigates to the tickets
 * list page, stops the auto-sync toggle, selects the ONE row matching
 * `externalId`, opens the "Cambiar Estado" modal, picks `status` in
 * `#valorSelect`, confirms, and detects success via the modal closing —
 * never `page.evaluate` with interpolated text (Threat Matrix).
 */
export interface SuricataStatusSession extends SuricataAuthSession {
  /** Drives Suricata's list-page bulk "Cambiar Estado" modal for the ONE ticket identified by `externalId`. */
  changeTicketStatus(externalId: string, status: string): Promise<void>;
}

export interface PlaywrightSuricataStatusConfig {
  /** D3 — the status lane, like the other three autonomous actions, always requests the session at 'high' priority. */
  sessionTimeoutMs: number;
}

export class PlaywrightSuricataStatus implements SuricataTicketStatusPort {
  constructor(
    private readonly session: SuricataSession<SuricataStatusSession>,
    private readonly cfg: PlaywrightSuricataStatusConfig,
  ) {}

  async changeStatus(externalId: string, status: string): Promise<void> {
    await this.session.withSession({ priority: 'high', timeoutMs: this.cfg.sessionTimeoutMs }, async (s) => {
      await s.changeTicketStatus(externalId, status);
    });
  }
}

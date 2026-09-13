/**
 * suricata-bot-autonomous-actions (Phase D, task D.1, design D3.b, spec
 * suricata-internal-note NOTE-4/NOTE-7) — the adapter that posts a REAL
 * internal note on a Suricata ticket. Molde `PlaywrightSuricataReply.ts` line
 * for line: a narrow structural session interface extending
 * `SuricataAuthSession`, a `sessionTimeoutMs` config, and a single
 * `this.session.withSession({ priority: 'high', timeoutMs }, ...)` call — the
 * note lane must never starve behind a 15-minute `low` priority sync tick.
 *
 * NOTE-7 — auto-sync handling: unlike close/status (which act on the LIST
 * page's bulk-selection modal, vulnerable to a mid-flow redraw clearing the
 * checkbox, B.6), the note action operates on the ticket's OWN detail page
 * (`/ticketunico?tick={externalId}`, `actionSelectors.ts`'s
 * `SURICATA_TICKET_DETAIL_PATH`) addressed directly by `externalId` in the
 * URL — there is no list selection to lose. The real implementation of
 * `postNote` re-confirms `SURICATA_INTERNAL_NOTE_SELECTORS.ticketIdHiddenField`
 * matches `externalId` right before clicking Crear and fails closed
 * (`SuricataActionNotAppliedError`) rather than posting on a stale/wrong
 * ticket if a navigation raced underneath it.
 *
 * Threat Matrix (design.md) — the text is sent via `fill`/`type`, NEVER via
 * `page.evaluate` with interpolation, exactly like the reply lane.
 */
import type { SuricataInternalNotePort } from '@domain/ports/SuricataInternalNotePort';
import { SuricataSession, type SuricataAuthSession } from './SuricataSession';

/**
 * Narrow structural contract `PlaywrightSuricataInternalNote` needs on top of
 * `SuricataAuthSession`. The real implementation navigates to
 * `SURICATA_TICKET_DETAIL_PATH?tick={externalId}`, fills
 * `SURICATA_INTERNAL_NOTE_SELECTORS.commentTextarea`, re-confirms the
 * ticket-id hidden field (NOTE-7), clicks `submitButton`, and detects success
 * via the textarea going back to empty — never `page.evaluate` with
 * interpolated text (Threat Matrix).
 */
export interface SuricataInternalNoteSession extends SuricataAuthSession {
  /** Navigates to the ticket's detail page and posts `text` as an internal note, verbatim. */
  postNote(externalId: string, text: string): Promise<void>;
}

export interface PlaywrightSuricataInternalNoteConfig {
  /** D3 — the note lane, like the other three autonomous actions, always requests the session at 'high' priority. */
  sessionTimeoutMs: number;
}

export class PlaywrightSuricataInternalNote implements SuricataInternalNotePort {
  constructor(
    private readonly session: SuricataSession<SuricataInternalNoteSession>,
    private readonly cfg: PlaywrightSuricataInternalNoteConfig,
  ) {}

  async addNote(externalId: string, note: string): Promise<void> {
    await this.session.withSession({ priority: 'high', timeoutMs: this.cfg.sessionTimeoutMs }, async (s) => {
      await s.postNote(externalId, note);
    });
  }
}

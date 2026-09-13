import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataBotActionAuditRepository } from '@domain/ports/SuricataBotActionAuditRepository';
import type { SuricataInternalNotePort } from '@domain/ports/SuricataInternalNotePort';
import { DomainError } from '@domain/errors';
import { SuricataTicketNotFoundError, SuricataBotActionFailedError } from '@domain/errors/suricata';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';

export interface AddSuricataInternalNoteInput {
  ticketExternalId: string;
  note: string;
}

export interface AddSuricataInternalNoteResult {
  auditId: string;
  /** Always `true` when this resolves — the use case only returns after `addNote` resolved. */
  applied: true;
  /**
   * `false` when the note WAS posted but flipping the audit row to `'applied'`
   * failed. The post is done and MUST NOT be retried — reconciliation is a
   * read of this flag, never a resend (D4, molde `ReplyToSuricataTicketResult`).
   */
  auditPersisted: boolean;
}

/**
 * suricata-bot-autonomous-actions (Phase D, task D.2, spec suricata-internal-note
 * NOTE-1..7, design D4/D5) — orchestrates a guarded, audited internal-note
 * post, molde `ReplyToSuricataTicket`/`SubmitSuricataVerdict`:
 *
 *   1. Reject empty/whitespace-only text (NOTE-2) BEFORE touching the ticket
 *      repo, the audit repo, or the port — no side effect for an invalid
 *      request.
 *   2. Resolve the ticket by `externalId` (NOTE-3 — must exist in the
 *      mirror); 404 BEFORE any audit row exists.
 *   3. Write the audit row FIRST, `outcome:'failed'` provisionally (D5 —
 *      audit the ATTEMPT, not the success), BEFORE the port (and therefore
 *      the shared session, D3.c) is ever invoked.
 *   4. Call `SuricataInternalNotePort.addNote` — a failure leaves the row
 *      `'failed'` with the error message and re-throws wrapped in
 *      `SuricataBotActionFailedError` so the HTTP layer can surface
 *      `auditId` (never a false success).
 *   5. Only AFTER the post resolved, flip the audit row to `'applied'`. This
 *      write is deliberately OUTSIDE the try: a bookkeeping failure here must
 *      never be reported as a post failure, because the note already reached
 *      real Suricata and a "retry" would post it twice. It surfaces as
 *      `auditPersisted: false` instead.
 *
 * NOTE-5 — this use case never touches status/priority/area/assignment/the
 * customer-visible conversation: only `SuricataInternalNotePort.addNote` is
 * called, nothing else on `SuricataTicketRepository` beyond the initial read.
 */
export class AddSuricataInternalNote {
  constructor(
    private readonly tickets: SuricataTicketRepository,
    private readonly audits: SuricataBotActionAuditRepository,
    private readonly notePort: SuricataInternalNotePort,
  ) {}

  async execute(input: AddSuricataInternalNoteInput): Promise<AddSuricataInternalNoteResult> {
    if (!input.note || input.note.trim() === '') {
      throw new DomainError('Note text must not be empty', 'VALIDATION_ERROR');
    }

    const ticket = await this.tickets.findByExternalId(input.ticketExternalId);
    if (!ticket) throw new SuricataTicketNotFoundError(input.ticketExternalId);

    // D5 — audit the ATTEMPT before the port/session is ever touched.
    const audit = await this.audits.record({
      ticketId: ticket.id,
      actorLogin: API_SURICATA_USER_LOGIN,
      payload: { actionType: 'note', text: input.note },
    });

    // The try block wraps ONLY the post. Everything after this line runs in a
    // world where the note is already on the real ticket, so no failure past
    // it may surface as "not posted" — that is what invites a double post.
    try {
      await this.notePort.addNote(ticket.externalId, input.note);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof DomainError ? err.code : 'SURICATA_UNAVAILABLE';
      // Best-effort: if recording the failure ALSO fails, the post failure is
      // still the truth the operator needs, so it is what propagates.
      try {
        await this.audits.markOutcome(audit.id, { outcome: 'failed', error: message });
      } catch (auditErr) {
        console.error(
          `[suricata-bot-note] audit ${audit.id}: could not record the post failure: ${(auditErr as Error).message}`,
        );
      }
      throw new SuricataBotActionFailedError(code, message, audit.id);
    }

    // ── Past this point the note IS posted. Bookkeeping only. ──
    let auditPersisted = true;
    try {
      await this.audits.markOutcome(audit.id, { outcome: 'applied', completedAt: new Date().toISOString() });
    } catch (auditErr) {
      // Loud, but NOT propagated: re-throwing here would tell the operator
      // the post failed (502) when it did not, and a retry would post the
      // same note to real Suricata twice.
      auditPersisted = false;
      console.error(
        `[suricata-bot-note] audit ${audit.id}: note WAS POSTED to ticket ${ticket.externalId} but the audit row could not be flipped to 'applied': ${(auditErr as Error).message}`,
      );
    }

    return { auditId: audit.id, applied: true, auditPersisted };
  }
}

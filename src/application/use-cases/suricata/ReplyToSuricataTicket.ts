import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataReplyAuditRepository } from '@domain/ports/SuricataReplyAuditRepository';
import type { SuricataReplyPort } from '@domain/ports/SuricataReplyPort';
import { DomainError } from '@domain/errors';
import {
  SuricataReplyConfirmationMismatchError,
  SuricataTicketNotFoundError,
  SuricataReplySendFailedError,
} from '@domain/errors/suricata';
import { computeSuricataReplyConfirmation } from '@domain/entities/suricataReplyConfirmation';

export interface ReplyToSuricataTicketInput {
  /** LOCAL `SuricataTicket.id` — the internal panel addresses tickets by their mirror id, not `externalId`. */
  ticketId: string;
  /** RbacUser that confirmed the send (REPLY-1's RBAC gate already ran at the route level). */
  actorId: string;
  body: string;
  /** sha256(body), computed client-side (REPLY-2) — the server recomputes and compares. */
  confirm: string;
}

export interface ReplyToSuricataTicketResult {
  replyAuditId: string;
  /**
   * Always `true` when this resolves — the use case only returns after
   * `sendReply` resolved. It is explicit (rather than implied by "no throw")
   * so the operator-facing response can never be read as ambiguous.
   */
  sent: true;
  /**
   * `false` when the message WAS sent but flipping the audit row to `'sent'`
   * failed (e.g. the DB blinked). The send is done and MUST NOT be retried;
   * only the bookkeeping is behind. The audit row stays at its provisional
   * `'failed'` state, so reconciliation is a read of this flag, not a resend.
   */
  auditPersisted: boolean;
}

/**
 * suricata-tickets-mirror (Phase E, task E.2, spec suricata-ticket-reply
 * REPLY-1..6, design D10) — orchestrates a guarded, audited send:
 *
 *   1. Recompute sha256(body) and compare to `confirm` (REPLY-2) — a
 *      mismatch is rejected BEFORE touching the ticket repo, the audit repo,
 *      or the port. No audit row is ever written for a mismatched confirm.
 *   2. Resolve the ticket by its LOCAL id (REPLY-3 — must exist in the
 *      mirror); 404 if missing.
 *   3. Write the audit row FIRST, `outcome='failed'` provisionally (REPLY-4 —
 *      D10: "auditar el INTENTO, no el éxito"), BEFORE the port (and
 *      therefore the shared session, D3.c) is ever invoked.
 *   4. Call `SuricataReplyPort.sendReply` — a SEND failure leaves the row
 *      'failed' with the error message and re-throws wrapped in
 *      `SuricataReplySendFailedError` so the HTTP layer can surface
 *      `replyAuditId` (REPLY-5 — never a false success).
 *   5. Only AFTER the send resolved, flip the audit row to 'sent'. This write
 *      is deliberately OUTSIDE the send's try: a bookkeeping failure here
 *      must never be reported as a send failure, because the message already
 *      reached a real customer and a "retry" would deliver it twice. It
 *      surfaces as `auditPersisted: false` instead (REPLY-5 also means never a
 *      false FAILURE).
 *
 * D3.c — this use case never touches `SuricataSession`/priority/locks: those
 * are entirely an adapter concern (`PlaywrightSuricataReply` acquires the
 * session internally, same pattern as `PlaywrightSuricataScraper`).
 */
export class ReplyToSuricataTicket {
  constructor(
    private readonly tickets: SuricataTicketRepository,
    private readonly audits: SuricataReplyAuditRepository,
    private readonly replyPort: SuricataReplyPort,
  ) {}

  async execute(input: ReplyToSuricataTicketInput): Promise<ReplyToSuricataTicketResult> {
    const expectedConfirm = computeSuricataReplyConfirmation(input.body);
    if (expectedConfirm !== input.confirm) {
      throw new SuricataReplyConfirmationMismatchError();
    }

    const ticket = await this.tickets.findById(input.ticketId);
    if (!ticket) throw new SuricataTicketNotFoundError(input.ticketId);

    // REPLY-4 — audit the ATTEMPT before the port/session is ever touched.
    const audit = await this.audits.record({
      ticketId: ticket.id,
      actorId: input.actorId,
      body: input.body,
    });

    // The try block wraps ONLY the send. Everything after this line runs in a
    // world where the customer already has the message, so no failure past it
    // may surface as "not sent" — that is what invites a double send.
    try {
      await this.replyPort.sendReply(ticket.externalId, input.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof DomainError ? err.code : 'SURICATA_UNAVAILABLE';
      // Best-effort: if recording the failure ALSO fails, the send failure is
      // still the truth the operator needs, so it is what propagates.
      try {
        await this.audits.markOutcome(audit.id, { outcome: 'failed', error: message });
      } catch (auditErr) {
        console.error(
          `[suricata-reply] audit ${audit.id}: could not record the send failure: ${(auditErr as Error).message}`,
        );
      }
      throw new SuricataReplySendFailedError(code, message, audit.id);
    }

    // ── Past this point the message IS out. Bookkeeping only. ──
    let auditPersisted = true;
    try {
      await this.audits.markOutcome(audit.id, { outcome: 'sent', sentAt: new Date().toISOString() });
    } catch (auditErr) {
      // Loud, but NOT propagated: re-throwing here would tell the operator the
      // send failed (502) when it did not, and a retry would deliver the same
      // message to a real customer twice. The audit row stays provisionally
      // 'failed' and `auditPersisted: false` marks it for reconciliation.
      auditPersisted = false;
      console.error(
        `[suricata-reply] audit ${audit.id}: reply WAS SENT to ticket ${ticket.externalId} but the audit row could not be flipped to 'sent': ${(auditErr as Error).message}`,
      );
    }

    return { replyAuditId: audit.id, sent: true, auditPersisted };
  }
}

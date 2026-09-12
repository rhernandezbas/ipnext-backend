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
 *   4. Call `SuricataReplyPort.sendReply` — success flips the audit row to
 *      'sent' with `sentAt`; any failure leaves it 'failed' with the error
 *      message and re-throws wrapped in `SuricataReplySendFailedError` so the
 *      HTTP layer can surface `replyAuditId` (REPLY-5 — never a false
 *      success).
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

    try {
      await this.replyPort.sendReply(ticket.externalId, input.body);
      const sentAt = new Date().toISOString();
      await this.audits.markOutcome(audit.id, { outcome: 'sent', sentAt });
      return { replyAuditId: audit.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.audits.markOutcome(audit.id, { outcome: 'failed', error: message });
      const code = err instanceof DomainError ? err.code : 'SURICATA_UNAVAILABLE';
      throw new SuricataReplySendFailedError(code, message, audit.id);
    }
  }
}

import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataBotActionAuditRepository } from '@domain/ports/SuricataBotActionAuditRepository';
import type { BotpressReplyPort } from '@domain/ports/BotpressReplyPort';
import { DomainError } from '@domain/errors';
import { SuricataTicketNotFoundError, SuricataBotActionFailedError, SuricataActionNotAppliedError } from '@domain/errors/suricata';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';

export interface SendAutonomousSuricataReplyInput {
  ticketExternalId: string;
  body: string;
}

export interface SendAutonomousSuricataReplyResult {
  auditId: string;
  /** Always `true` when this resolves — the use case only returns after `sendReply` resolved. */
  applied: true;
  /**
   * `false` when the reply WAS sent but flipping the audit row to
   * `'applied'` failed. The send is done and MUST NOT be retried —
   * reconciliation is a read of this flag, never a resend (D4, molde
   * `CloseSuricataTicketResult`/`AddSuricataInternalNoteResult`).
   */
  auditPersisted: boolean;
  /** Real proof of dispatch when Botpress populates `tags['whatsapp:id']` on the sent message. */
  whatsappId?: string;
}

/**
 * suricata-bot-autonomous-actions (Phase G, task G.3, spec EXTREPLY-1..5,
 * design D3.b/D4.a CORRECTED 2026-09-13) — orchestrates a guarded, audited
 * autonomous reply through the Botpress Chat API, molde
 * `CloseSuricataTicket`/`AddSuricataInternalNote`.
 *
 * **A NEW class, distinct from `ReplyToSuricataTicket`** (design D4.a): no
 * `confirm` field (nothing for a bot to re-confirm — it would only recompute
 * a hash from the same variable it is about to send, proving nothing), no
 * `actorId` (the caller is the bot, not an `RbacUser`), addressed by
 * `externalId` instead of the local mirror id — four contract differences,
 * on purpose. The production human path (`ReplyToSuricataTicket`) is
 * untouched by this class.
 *
 *   1. Reject empty/whitespace-only body (EXTREPLY-3) BEFORE touching the
 *      ticket repo, the audit repo, or the port — no side effect for an
 *      invalid request.
 *   2. Resolve the ticket by `externalId`; 404 BEFORE any audit row exists.
 *   3. Write the audit row FIRST, `outcome:'failed'` provisionally (D5 —
 *      audit the ATTEMPT, not the success), BEFORE the port is ever invoked.
 *   4. Resolve `externalId -> conversationId` via
 *      `BotpressReplyPort.getConversationId` (the SAME `metadata-ticket`
 *      lookup `botpressMessages.ts` makes, reused — never duplicated). A
 *      ticket with no linked conversation is a DISTINCT failure
 *      (`SuricataActionNotAppliedError`, 502), not a generic crash. Then
 *      call `BotpressReplyPort.sendReply`. Either failure leaves the audit
 *      row `'failed'` with the error message and re-throws wrapped in
 *      `SuricataBotActionFailedError` so the HTTP layer can surface
 *      `auditId` (never a false success).
 *   5. Only AFTER the send resolved, flip the audit row to `'applied'`. This
 *      write is deliberately OUTSIDE the try: a bookkeeping failure here
 *      must never be reported as a send failure, because the message already
 *      reached a real customer and a "retry" would deliver it twice. It
 *      surfaces as `auditPersisted: false` instead.
 */
export class SendAutonomousSuricataReply {
  constructor(
    private readonly tickets: SuricataTicketRepository,
    private readonly audits: SuricataBotActionAuditRepository,
    private readonly replyPort: BotpressReplyPort,
  ) {}

  async execute(input: SendAutonomousSuricataReplyInput): Promise<SendAutonomousSuricataReplyResult> {
    if (!input.body || input.body.trim() === '') {
      throw new DomainError('Reply body must not be empty', 'VALIDATION_ERROR');
    }

    const ticket = await this.tickets.findByExternalId(input.ticketExternalId);
    if (!ticket) throw new SuricataTicketNotFoundError(input.ticketExternalId);

    // D5 — audit the ATTEMPT before the port is ever touched.
    const audit = await this.audits.record({
      ticketId: ticket.id,
      actorLogin: API_SURICATA_USER_LOGIN,
      payload: { actionType: 'reply', body: input.body },
    });

    // The try block wraps conversation resolution AND the send. Everything
    // after this line runs in a world where the customer already has the
    // message, so no failure past it may surface as "not sent" — that is
    // what invites a double send.
    let whatsappId: string | undefined;
    try {
      const conversationId = await this.replyPort.getConversationId(ticket.externalId);
      if (!conversationId) {
        throw new SuricataActionNotAppliedError(
          `Suricata ticket ${ticket.externalId} has no linked Botpress conversation (metadata-ticket returned no conversation_id)`,
        );
      }
      const result = await this.replyPort.sendReply(conversationId, input.body);
      whatsappId = result.whatsappId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof DomainError ? err.code : 'SURICATA_UNAVAILABLE';
      // Best-effort: if recording the failure ALSO fails, the send failure is
      // still the truth the operator needs, so it is what propagates.
      try {
        await this.audits.markOutcome(audit.id, { outcome: 'failed', error: message });
      } catch (auditErr) {
        console.error(
          `[suricata-bot-reply] audit ${audit.id}: could not record the send failure: ${(auditErr as Error).message}`,
        );
      }
      throw new SuricataBotActionFailedError(code, message, audit.id);
    }

    // ── Past this point the message IS out. Bookkeeping only. ──
    let auditPersisted = true;
    try {
      await this.audits.markOutcome(audit.id, { outcome: 'applied', completedAt: new Date().toISOString() });
    } catch (auditErr) {
      // Loud, but NOT propagated: re-throwing here would tell the operator
      // the send failed (502) when it did not, and a retry would deliver the
      // same message to a real customer twice.
      auditPersisted = false;
      console.error(
        `[suricata-bot-reply] audit ${audit.id}: reply WAS SENT to ticket ${ticket.externalId} but the audit row could not be flipped to 'applied': ${(auditErr as Error).message}`,
      );
    }

    return { auditId: audit.id, applied: true, auditPersisted, whatsappId };
  }
}

import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataBotActionAuditRepository } from '@domain/ports/SuricataBotActionAuditRepository';
import type { SuricataTicketClosePort } from '@domain/ports/SuricataTicketClosePort';
import { DomainError } from '@domain/errors';
import { SuricataTicketNotFoundError, SuricataBotActionFailedError } from '@domain/errors/suricata';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';

export interface CloseSuricataTicketInput {
  ticketExternalId: string;
  reason: string;
}

export interface CloseSuricataTicketResult {
  auditId: string;
  /** Always `true` when this resolves — the use case only returns after `close` resolved. */
  applied: true;
  /**
   * `false` when the ticket WAS closed but flipping the audit row to
   * `'applied'` failed. The close is done and MUST NOT be retried —
   * reconciliation is a read of this flag, never a resend (D4, molde
   * `AddSuricataInternalNoteResult`).
   */
  auditPersisted: boolean;
}

/**
 * suricata-bot-autonomous-actions (Phase F, task F.2, spec suricata-ticket-close
 * CLOSE-1..7, design D4/D5/D5.a CORRECTED 2026-09-13) — orchestrates a
 * guarded, audited ticket close, molde `AddSuricataInternalNote`:
 *
 *   1. Reject empty/whitespace-only reason (CLOSE-2) BEFORE touching the
 *      ticket repo, the audit repo, or the port — no side effect for an
 *      invalid request.
 *   2. Resolve the ticket by `externalId` (CLOSE-3 — must exist in the
 *      mirror); 404 BEFORE any audit row exists.
 *   3. Write the audit row FIRST, `outcome:'failed'` provisionally (D5 —
 *      audit the ATTEMPT, not the success), BEFORE the port (and therefore
 *      the shared session, D3.c) is ever invoked.
 *   4. Call `SuricataTicketClosePort.close` — a failure leaves the row
 *      `'failed'` with the error message and re-throws wrapped in
 *      `SuricataBotActionFailedError` so the HTTP layer can surface
 *      `auditId` (never a false success).
 *   5. Only AFTER the close resolved, flip the audit row to `'applied'`.
 *      This write is deliberately OUTSIDE the try: a bookkeeping failure
 *      here must never be reported as a close failure, because the ticket
 *      is already closed on real Suricata and a "retry" would attempt it
 *      twice. It surfaces as `auditPersisted: false` instead.
 *
 * D5.a (CORRECTED) — unlike `ChangeSuricataTicketStatus`, this use case
 * deliberately does NOT call `ticketRepo.setStatus` (or any other local
 * write) on success: live verification found no closed-status literal in
 * Suricata's own status catalog to transition the mirror to. The mirror's
 * own fields catch up on the next 15-minute sync tick, per the same
 * "mirror write is a latency optimization" philosophy already applied
 * elsewhere in this change — there is simply nothing local left to write
 * here beyond the audit row.
 */
export class CloseSuricataTicket {
  constructor(
    private readonly tickets: SuricataTicketRepository,
    private readonly audits: SuricataBotActionAuditRepository,
    private readonly closePort: SuricataTicketClosePort,
  ) {}

  async execute(input: CloseSuricataTicketInput): Promise<CloseSuricataTicketResult> {
    if (!input.reason || input.reason.trim() === '') {
      throw new DomainError('Close reason must not be empty', 'VALIDATION_ERROR');
    }

    const ticket = await this.tickets.findByExternalId(input.ticketExternalId);
    if (!ticket) throw new SuricataTicketNotFoundError(input.ticketExternalId);

    // D5 — audit the ATTEMPT before the port/session is ever touched.
    const audit = await this.audits.record({
      ticketId: ticket.id,
      actorLogin: API_SURICATA_USER_LOGIN,
      payload: { actionType: 'close', reason: input.reason },
    });

    // The try block wraps ONLY the close call. Everything after this line
    // runs in a world where the ticket is already closed on the real
    // ticket, so no failure past it may surface as "not closed" — that is
    // what invites a double action.
    try {
      await this.closePort.close(ticket.externalId, input.reason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof DomainError ? err.code : 'SURICATA_UNAVAILABLE';
      // Best-effort: if recording the failure ALSO fails, the close failure
      // is still the truth the operator needs, so it is what propagates.
      try {
        await this.audits.markOutcome(audit.id, { outcome: 'failed', error: message });
      } catch (auditErr) {
        console.error(
          `[suricata-bot-close] audit ${audit.id}: could not record the close failure: ${(auditErr as Error).message}`,
        );
      }
      throw new SuricataBotActionFailedError(code, message, audit.id);
    }

    // ── Past this point the ticket IS closed on real Suricata. ──
    // D5.a — deliberately no mirror write here: there is no closed-status
    // literal to set, unlike `ChangeSuricataTicketStatus`. The sync pipeline
    // reconciles whatever local fields reflect closure within one tick.
    let auditPersisted = true;
    try {
      await this.audits.markOutcome(audit.id, { outcome: 'applied', completedAt: new Date().toISOString() });
    } catch (auditErr) {
      // Loud, but NOT propagated: re-throwing here would tell the operator
      // the close failed (502) when it did not, and a retry would close
      // the same ticket on real Suricata twice.
      auditPersisted = false;
      console.error(
        `[suricata-bot-close] audit ${audit.id}: ticket ${ticket.externalId} WAS CLOSED but the audit row could not be flipped to 'applied': ${(auditErr as Error).message}`,
      );
    }

    return { auditId: audit.id, applied: true, auditPersisted };
  }
}

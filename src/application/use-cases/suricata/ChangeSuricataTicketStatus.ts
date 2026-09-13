import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataBotActionAuditRepository } from '@domain/ports/SuricataBotActionAuditRepository';
import type { SuricataTicketStatusPort } from '@domain/ports/SuricataTicketStatusPort';
import { DomainError } from '@domain/errors';
import { SuricataTicketNotFoundError, SuricataBotActionFailedError } from '@domain/errors/suricata';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';
import { isSuricataStatusValue } from '@domain/constants/suricataStatus';

export interface ChangeSuricataTicketStatusInput {
  ticketExternalId: string;
  status: string;
}

export interface ChangeSuricataTicketStatusResult {
  auditId: string;
  /** Always `true` when this resolves — the use case only returns after `changeStatus` resolved. */
  applied: true;
  /**
   * `false` when the status WAS changed in real Suricata but flipping the
   * audit row to `'applied'` failed. The change is done and MUST NOT be
   * retried — reconciliation is a read of this flag, never a resend (D4,
   * molde `AddSuricataInternalNoteResult`).
   */
  auditPersisted: boolean;
}

/**
 * suricata-bot-autonomous-actions (Phase E, task E.4, spec suricata-ticket-status
 * STATUS-1..7, design D4/D5/D5.a) — orchestrates a guarded, audited status
 * change, molde `AddSuricataInternalNote`, extended with a THIRD ordering
 * step (D5.a — the mirror's `status` field, not just the audit row):
 *
 *   1. Reject a status value outside the D6-captured allowlist (STATUS-2,
 *      Threat Matrix "Selector injection") BEFORE touching the ticket repo,
 *      the audit repo, or the port — it is never given the chance to reach
 *      a selector.
 *   2. Resolve the ticket by `externalId` (STATUS-3 — must exist in the
 *      mirror); 404 BEFORE any audit row exists.
 *   3. Write the audit row FIRST, `outcome:'failed'` provisionally (D5 —
 *      audit the ATTEMPT, not the success), BEFORE the port is ever invoked.
 *   4. Call `SuricataTicketStatusPort.changeStatus` — a failure leaves the
 *      row `'failed'` with the error message and re-throws wrapped in
 *      `SuricataBotActionFailedError` so the HTTP layer can surface
 *      `auditId` (never a false success). The mirror is NEVER touched on
 *      this path (STATUS-5).
 *   5. Only AFTER the remote change resolved, update the mirror's `status`
 *      via `ticketRepo.setStatus` (D5.a — Suricata write first, mirror
 *      after). A mirror-write failure here is logged, not propagated: the
 *      real Suricata status already changed, the sync pipeline reconciles
 *      the mirror within one tick regardless (design D5).
 *   6. Flip the audit row to `'applied'`, deliberately OUTSIDE the try: a
 *      bookkeeping failure here must never be reported as a change failure,
 *      because the status already changed on real Suricata and a "retry"
 *      would attempt it twice. It surfaces as `auditPersisted: false`.
 */
export class ChangeSuricataTicketStatus {
  constructor(
    private readonly tickets: SuricataTicketRepository,
    private readonly audits: SuricataBotActionAuditRepository,
    private readonly statusPort: SuricataTicketStatusPort,
  ) {}

  async execute(input: ChangeSuricataTicketStatusInput): Promise<ChangeSuricataTicketStatusResult> {
    // STATUS-2 / Threat Matrix (selector injection) — an unrecognized status
    // value is rejected before it can ever reach a selector: it is matched
    // against the D6-captured allowlist here, never concatenated into a
    // locator string by the driver.
    if (!isSuricataStatusValue(input.status)) {
      throw new DomainError(`Unknown Suricata status value: "${input.status}"`, 'VALIDATION_ERROR');
    }

    const ticket = await this.tickets.findByExternalId(input.ticketExternalId);
    if (!ticket) throw new SuricataTicketNotFoundError(input.ticketExternalId);

    // D5 — audit the ATTEMPT before the port/session is ever touched.
    const audit = await this.audits.record({
      ticketId: ticket.id,
      actorLogin: API_SURICATA_USER_LOGIN,
      payload: { actionType: 'status', status: input.status },
    });

    // The try block wraps ONLY the remote call. Everything after this line
    // runs in a world where the status is already changed on the real
    // ticket, so no failure past it may surface as "not changed" — that is
    // what invites a double action.
    try {
      await this.statusPort.changeStatus(ticket.externalId, input.status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof DomainError ? err.code : 'SURICATA_UNAVAILABLE';
      // Best-effort: if recording the failure ALSO fails, the change failure
      // is still the truth the operator needs, so it is what propagates.
      try {
        await this.audits.markOutcome(audit.id, { outcome: 'failed', error: message });
      } catch (auditErr) {
        console.error(
          `[suricata-bot-status] audit ${audit.id}: could not record the status-change failure: ${(auditErr as Error).message}`,
        );
      }
      throw new SuricataBotActionFailedError(code, message, audit.id);
    }

    // ── Past this point the status IS changed on real Suricata. ──
    // D5.a — mirror write is a best-effort latency optimization, never the
    // source of truth: the sync pipeline reconciles it within one tick
    // regardless, so a failure here must not be reported as a change
    // failure (the remote action already succeeded).
    try {
      await this.tickets.setStatus(ticket.id, input.status);
    } catch (mirrorErr) {
      console.error(
        `[suricata-bot-status] ticket ${ticket.externalId}: status changed on real Suricata but the mirror update failed: ${(mirrorErr as Error).message}`,
      );
    }

    let auditPersisted = true;
    try {
      await this.audits.markOutcome(audit.id, { outcome: 'applied', completedAt: new Date().toISOString() });
    } catch (auditErr) {
      // Loud, but NOT propagated: re-throwing here would tell the operator
      // the change failed (502) when it did not, and a retry would apply
      // the same status change to real Suricata twice.
      auditPersisted = false;
      console.error(
        `[suricata-bot-status] audit ${audit.id}: status WAS CHANGED on ticket ${ticket.externalId} but the audit row could not be flipped to 'applied': ${(auditErr as Error).message}`,
      );
    }

    return { auditId: audit.id, applied: true, auditPersisted };
  }
}

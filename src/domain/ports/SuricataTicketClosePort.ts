/**
 * suricata-bot-autonomous-actions (Phase A, task A.8, design D3.a/D3.c) —
 * the port that closes a ticket on the real Suricata site. A separate port
 * from `SuricataReplyPort`/`SuricataTicketStatusPort`/`SuricataInternalNotePort`
 * on purpose (D3.a — three ports, not one combined port): with per-action
 * flags AND per-action ports, a caller can be inert in two independent ways,
 * and injecting the *close* capability never also hands over *note* or
 * *reply*.
 *
 * CORRECTED 2026-09-13 (live capture, design D5.a): closing is its OWN
 * Suricata action, independent from "Cambiar Estado" — there is no
 * closed-status value in the status catalog (`suricataStatus.ts`) to
 * transition to. The reason is NOT a ticket column either way, it lives in
 * `SuricataBotActionAudit.payload`.
 */
export interface SuricataTicketClosePort {
  /** Closes the ticket identified by `externalId` with `reason`. Throws on any failure — never resolves partially. */
  close(externalId: string, reason: string): Promise<void>;
}

/**
 * suricata-bot-autonomous-actions (Phase A, task A.8, design D3.a/D3.c) —
 * the port that changes a ticket's status on the real Suricata site. A
 * separate port from `SuricataReplyPort`/`SuricataTicketClosePort`/
 * `SuricataInternalNotePort` on purpose (D3.a).
 *
 * `status` is the RAW Suricata string (same convention as
 * `SuricataTicketRecord.status`); the caller (use case + route) MUST match
 * it against the D6-captured allowlist BEFORE it ever reaches this port —
 * this port never validates it, the same way `PlaywrightSuricataReply`
 * never validates `body` (Threat Matrix: selector injection guard lives at
 * the use case/route layer, not the driver).
 */
export interface SuricataTicketStatusPort {
  /** Changes the ticket identified by `externalId` to `status`. Throws on any failure — never resolves partially. */
  changeStatus(externalId: string, status: string): Promise<void>;
}

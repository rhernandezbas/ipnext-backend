/**
 * suricata-bot-autonomous-actions (Phase A, task A.8, design D3.a/D3.c) —
 * the port that adds an internal note to a ticket on the real Suricata
 * site. A separate port from `SuricataReplyPort`/`SuricataTicketClosePort`/
 * `SuricataTicketStatusPort` on purpose (D3.a).
 */
export interface SuricataInternalNotePort {
  /** Adds `note` as an internal note on the ticket identified by `externalId`. Throws on any failure — never resolves partially. */
  addNote(externalId: string, note: string): Promise<void>;
}

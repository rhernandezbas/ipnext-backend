/**
 * suricata-tickets-mirror (Phase E, task E.1, design D3/D10) — the ONE port
 * that WRITES to Suricata: sends a single message into a ticket's real
 * conversation. Read-only concerns live in `SuricataScraperPort` (D3.b — two
 * separate ports on purpose, so a caller can be given read access without
 * ever gaining the ability to reply).
 *
 * D3.c — no `lock`/`priority` in this signature: `PlaywrightSuricataReply`
 * (the only real adapter, itself unreachable until Phase J — see
 * `UnavailableSuricataReplyPort`) acquires the shared `SuricataSession` at
 * 'high' priority INTERNALLY, same pattern `PlaywrightSuricataScraper`
 * already established (D0/D4 — each port call acquires/releases the session
 * on its own). The domain and the use case stay blind to the lock.
 */
export interface SuricataReplyPort {
  /** Sends `body` verbatim into the ticket's conversation. Throws on any failure — never resolves partially. */
  sendReply(externalId: string, body: string): Promise<void>;
}

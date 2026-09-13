/**
 * suricata-bot-autonomous-actions (Phase G, task G.1, design D3.b CORRECTED
 * 2026-09-13) — the port that dispatches an autonomous reply. NOT a
 * Playwright driver: `PlaywrightSuricataReply.ts` stays exactly as
 * unimplemented as it always was (live verification found the customer
 * conversation renders inside a cross-origin, websocket-driven iframe a
 * Playwright `fill`/`type` cannot reliably reach). The real actuator is a
 * plain HTTP POST to the Botpress Chat API, using a Personal Access Token
 * Suricata's own backend leaks via an unauthenticated `metadata-merchant`
 * call — the SAME credential `botpressMessages.ts` already uses to READ
 * message history. See that file's security disclaimer, which applies
 * identically here: this PAT is exposed by an almost-certain Suricata-side
 * authorization bug, not an intentionally issued integration credential.
 *
 * Two methods, not one, because `SendAutonomousSuricataReply` (design D4.a)
 * must resolve `externalId -> conversationId` itself, through this SAME
 * port, before it can send — the application layer stays DIP-compliant
 * (depends on this port only, never on `SuricataBrowserSession`/Playwright
 * types) while still reusing `botpressMessages.ts`'s `metadata-ticket`
 * lookup instead of duplicating it at the infrastructure layer.
 */
export interface BotpressReplyPort {
  /**
   * Resolves a Suricata ticket's `externalId` to its Botpress
   * `conversation_id` (the same `metadata-ticket` lookup
   * `botpressMessages.ts` makes for reads). `null` when the ticket has no
   * linked Botpress conversation.
   */
  getConversationId(ticketExternalId: string): Promise<string | null>;

  /**
   * Sends `body` verbatim into the Botpress conversation identified by
   * `conversationId`. Returns the dispatched message's `whatsappId` when
   * Botpress populates `tags['whatsapp:id']` — real proof of dispatch, not
   * just an attempt flag (molde `SuricataReplyAudit`'s own philosophy).
   * Throws on any failure — never resolves partially.
   */
  sendReply(conversationId: string, body: string): Promise<{ whatsappId?: string }>;
}

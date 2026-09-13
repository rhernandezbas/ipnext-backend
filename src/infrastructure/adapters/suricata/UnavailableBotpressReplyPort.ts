/**
 * suricata-bot-autonomous-actions (Phase G) — CONSERVATIVE GUARD, molde
 * `UnavailableSuricataTicketClosePort.ts`. `app.ts` wires THIS class as the
 * `BotpressReplyPort` fallback whenever `SURICATA_BASE_URL`/
 * `SURICATA_BROWSER_WS` are unset — the same opt-in gate every other
 * autonomous-action port already uses. This is a SEPARATE, stricter gate
 * than the `suricata-bot-reply-enabled` feature flag (dark by default): even
 * with the flag flipped ON, this capability physically cannot reach Botpress
 * unless the shared Playwright sidecar (the transport `session.fetchJson`
 * needs) is actually configured.
 *
 * Reuses `SuricataAuthError` (`SURICATA_UNAVAILABLE`, 502) rather than a new
 * error class, same reasoning as the other three `Unavailable*Port` guards.
 */
import type { BotpressReplyPort } from '@domain/ports/BotpressReplyPort';
import { SuricataAuthError } from '@domain/errors/suricata';

export class UnavailableBotpressReplyPort implements BotpressReplyPort {
  async getConversationId(_ticketExternalId: string): Promise<string | null> {
    throw new SuricataAuthError(
      'No live Suricata action driver is configured (SURICATA_BASE_URL/SURICATA_BROWSER_WS missing) — refusing to resolve conversation',
    );
  }

  async sendReply(_conversationId: string, _body: string): Promise<{ whatsappId?: string }> {
    throw new SuricataAuthError(
      'No live Suricata action driver is configured (SURICATA_BASE_URL/SURICATA_BROWSER_WS missing) — refusing to send reply',
    );
  }
}

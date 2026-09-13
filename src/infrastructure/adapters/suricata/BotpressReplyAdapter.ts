/**
 * suricata-bot-autonomous-actions (Phase G, task G.1, design D3.b CORRECTED
 * 2026-09-13) — plain HTTP adapter for `BotpressReplyPort`. NO
 * `SuricataAuthSession`, NO `SuricataSession.withSession` call, NO Playwright
 * import at the class level (`SuricataBrowserSession` is a narrow structural
 * type, same convention `botpressMessages.ts` already uses).
 *
 * Deliberately does NOT acquire the shared session mutex/priority queue:
 * `session.fetchJson` here only reaches hosts entirely unrelated to
 * Suricata's own authenticated cookie (`backend.suricata.chat`,
 * `api.botpress.cloud`) — there is no DOM state to serialize against, so
 * going through `withSession`/`ensureAuthenticated` would make an autonomous
 * reply wait behind unrelated sync/note/status/close work for zero isolation
 * benefit. `PlaywrightBrowserSession.fetchJson`'s own doc comment already
 * anticipates this exact reuse ("AND for the Botpress message lookup...").
 *
 * ⚠️ Same security caveat as `botpressMessages.ts`: `metadata-merchant`
 * leaks a real Botpress PAT with (almost certainly) no real authorization
 * check beyond the merchant slug — not an intentionally issued integration
 * credential. Never log or persist `tokenPa`; it is fetched fresh on every
 * call, never cached across sends.
 *
 * Threat Matrix (design D9 Threat Matrix / D10) — `body` reaches the JSON
 * POST body verbatim, via `payload.text`, NEVER interpolated into any
 * URL/header/query string (injection-safe by construction; asserted by a
 * test, not just claimed in this comment).
 */
import type { BotpressReplyPort } from '@domain/ports/BotpressReplyPort';
import { SURICATA_MERCHANT, type SuricataBrowserSession } from './PlaywrightSuricataScraper';
import { fetchSuricataBotpressMerchantConfig, fetchSuricataTicketConversationId } from './botpressMessages';
import { SuricataActionNotAppliedError } from '@domain/errors/suricata';

const BOTPRESS_API = 'https://api.botpress.cloud';

/**
 * Fixed agent/system sender id, observed live on every existing outgoing
 * message in this tenant's Botpress conversations (design D3.b, verified
 * end-to-end 2026-09-13 against real ticket #18923). Not a secret — it only
 * identifies WHO sent the message inside Botpress, it grants no access.
 */
const BOTPRESS_SYSTEM_SENDER_USER_ID = 'user_01JY3XV69J36PGGZ01T47QK324';

interface BotpressSendMessageResponse {
  message?: {
    id?: string;
    tags?: Record<string, string>;
  };
}

export class BotpressReplyAdapter implements BotpressReplyPort {
  constructor(
    private readonly session: SuricataBrowserSession,
    private readonly merchant: string = SURICATA_MERCHANT,
  ) {}

  async getConversationId(ticketExternalId: string): Promise<string | null> {
    return fetchSuricataTicketConversationId(this.session, this.merchant, ticketExternalId);
  }

  async sendReply(conversationId: string, body: string): Promise<{ whatsappId?: string }> {
    const merchantConfig = await fetchSuricataBotpressMerchantConfig(this.session, this.merchant);
    if (!merchantConfig) {
      throw new SuricataActionNotAppliedError(
        'Botpress is not configured for this merchant (metadata-merchant returned no token_pa/bot_id)',
      );
    }

    // `tags: {}` is REQUIRED by the Botpress API even when empty -- omitting
    // it returns a 400 "must have required property 'tags'" (live-verified
    // 2026-09-13). `body` is placed EXCLUSIVELY inside `payload.text`, never
    // touching the URL/headers -- see this file's Threat Matrix note above.
    const result = await this.session.fetchJson<BotpressSendMessageResponse>(`${BOTPRESS_API}/v1/chat/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${merchantConfig.tokenPa}`,
        'x-bot-id': merchantConfig.botId,
        'Content-Type': 'application/json',
      },
      body: {
        conversationId,
        userId: BOTPRESS_SYSTEM_SENDER_USER_ID,
        type: 'text',
        tags: {},
        payload: { text: body },
      },
    });

    // `fetchJson` already throws on a non-2xx status (PlaywrightBrowserSession);
    // a missing `message.id` on an otherwise-2xx body is the post-condition
    // marker check for a malformed/unconfirmed send -- same "click completed
    // but nothing confirms it" reasoning the other three drivers apply via
    // `SuricataActionNotAppliedError` (design D3.c).
    const messageId = result.message?.id;
    if (!messageId) {
      throw new SuricataActionNotAppliedError('Botpress reply response carries no message.id — send is unconfirmed');
    }

    return { whatsappId: result.message?.tags?.['whatsapp:id'] };
  }
}

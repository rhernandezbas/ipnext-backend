import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import type { WebhookDeliveryRepository } from '@domain/ports/WebhookDeliveryRepository';

/**
 * Chatwoot webhook payload — DOMAIN shape as received by this use case, AFTER the HMAC
 * middleware (B5) has verified the signature/timestamp and the route has JSON-parsed the
 * raw body. This use case never sees the raw bytes, only this parsed object.
 *
 * Field-path assumptions (VERIFIED against a live `.37` `message_created` webhook — no
 * longer best-effort): the TOP-LEVEL `message_type` is a STRING
 * ("incoming"/"outgoing"/"activity"/"template"), NOT the numeric enum the GET API uses
 * (0/1/2/3, still seen via `HttpChatwootGateway`'s fetch-on-open) — `mapMessageTypeToDirection`
 * accepts BOTH forms (H1). `private` (bool) marks an internal agent note: never persisted,
 * never bumps the mirror's preview (H2/§6). Contact identity for a MESSAGE-level event
 * travels under `conversation.meta.sender.{name,phone_number}` (M1) — NOT top-level
 * `meta.sender`, which only applies to CONVERSATION-level events
 * (`conversation_created`/`conversation_status_changed`, handled separately below).
 * `conversation.can_reply` mirrors Chatwoot's 24h-window flag (M2). `sender.name`
 * (top-level, message-only) is the MESSAGE's own sender display name — NOT necessarily
 * the contact (could be the agent on an outbound message) — kept deliberately separate
 * from `conversation.meta.sender.name`. Conversation-level events carry the
 * conversation's own id as the top-level `id`; message-level events nest it under
 * `conversation.id`.
 */
export interface ChatwootWebhookPayload {
  event: string;
  id?: number;
  content?: string | null;
  message_type?: number | string;
  created_at?: string | number;
  status?: string;
  /** H2 — true for an internal agent note (never persisted, never bumps the preview). */
  private?: boolean;
  conversation?: {
    id: number;
    /** M2 — Chatwoot's live 24h-window flag, only present on message-level events. */
    can_reply?: boolean;
    /** M1 — the REAL wire path for contact identity on a message-level event. */
    meta?: { sender?: { name?: string | null; phone_number?: string | null } | null };
  };
  sender?: { name?: string | null } | null;
  /** Only meaningful on CONVERSATION-level events (`conversation_created`/`conversation_status_changed`). */
  meta?: { sender?: { name?: string | null; phone_number?: string | null } | null };
}

const WEBHOOK_SOURCE = 'chatwoot';

/** H1 — accepts Chatwoot's real webhook STRING enum and the GET API's numeric enum. */
function mapMessageTypeToDirection(messageType: number | string | undefined): 'inbound' | 'outbound' | null {
  if (messageType === 0 || messageType === 'incoming') return 'inbound';
  if (messageType === 1 || messageType === 'outgoing') return 'outbound';
  return null; // 2/'activity', 3/'template', or unknown/undefined — never persisted (§7)
}

function toIsoTimestamp(raw: string | number | undefined): string {
  if (raw === undefined) return new Date().toISOString();
  if (typeof raw === 'number') return new Date(raw * 1000).toISOString(); // Chatwoot epoch seconds
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * ReceiveChatwootWebhook (F1, design §4, HOOK-3/4/5) — processes an already
 * signature-verified Chatwoot webhook delivery.
 *
 * Dedup (HOOK-3/ROB-2) is PROCESS-THEN-RECORD: `hasSeen` is a read-only check done
 * FIRST (a seen delivery is acked without touching `Conversation`/`ChatMessage` nor
 * re-recording); the event is then processed; the delivery is marked seen via
 * `recordIfNew` ONLY AFTER the handler completes successfully. Recording BEFORE
 * processing (the old order) would burn the delivery id even when the handler
 * throws, silently discarding Chatwoot's retry — the one copy of that event that
 * would ever succeed is gone for good.
 *
 * Never throws on a malformed or unsubscribed event (HOOK-5) — degrades to a no-op
 * so the webhook route can always ack 200 without risking Chatwoot's retry storm.
 */
export class ReceiveChatwootWebhook {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: ChatMessageRepository,
    private readonly deliveryRepo: WebhookDeliveryRepository,
  ) {}

  async execute(deliveryId: string, payload: ChatwootWebhookPayload): Promise<void> {
    const alreadySeen = await this.deliveryRepo.hasSeen(WEBHOOK_SOURCE, deliveryId);
    if (alreadySeen) return; // HOOK-3 — already processed, ack without reprocessing

    await this.process(payload); // may throw — delivery NOT recorded yet (ROB-2)

    await this.deliveryRepo.recordIfNew(WEBHOOK_SOURCE, deliveryId); // recorded ONLY after success
  }

  private async process(payload: ChatwootWebhookPayload): Promise<void> {
    switch (payload.event) {
      case 'message_created':
        return this.handleMessageCreated(payload);
      case 'conversation_created':
        return this.handleConversationCreated(payload);
      case 'conversation_status_changed':
        return this.handleConversationStatusChanged(payload);
      default:
        return; // HOOK-5 — unsubscribed event type, ignored without error
    }
  }

  private async handleMessageCreated(payload: ChatwootWebhookPayload): Promise<void> {
    const chatwootConversationId = payload.conversation?.id;
    if (chatwootConversationId === undefined) return; // malformed payload — no-op, never throws

    const createdAt = toIsoTimestamp(payload.created_at);
    const direction = mapMessageTypeToDirection(payload.message_type);
    const isPrivateNote = payload.private === true;
    // H2/§6 — an internal note or an activity/template system message is NOT
    // customer-facing: it must never bump the inbox preview/lastMessageAt.
    const bumpsPreview = direction !== null && !isPrivateNote;
    const sender = payload.conversation?.meta?.sender; // M1 — real wire path, not top-level meta.sender

    const conversation = await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId,
      contactName: sender?.name,
      contactPhone: sender?.phone_number,
      canReply: payload.conversation?.can_reply, // M2 — keeps the mirror's canReply fresh
      lastMessageAt: bumpsPreview ? createdAt : undefined,
      lastMessagePreview: bumpsPreview ? (payload.content ?? null) : undefined,
    });

    if (direction === null || isPrivateNote || payload.id === undefined) return; // §7/H2 — not persisted

    await this.messageRepo.upsertByChatwootMessageId({
      conversationId: conversation.id,
      chatwootMessageId: payload.id,
      direction,
      content: payload.content ?? '',
      senderName: payload.sender?.name,
      chatwootCreatedAt: createdAt,
    });
  }

  private async handleConversationCreated(payload: ChatwootWebhookPayload): Promise<void> {
    const chatwootConversationId = payload.id;
    if (chatwootConversationId === undefined) return;

    await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId,
      contactName: payload.meta?.sender?.name,
      contactPhone: payload.meta?.sender?.phone_number,
      status: payload.status,
    });
  }

  private async handleConversationStatusChanged(payload: ChatwootWebhookPayload): Promise<void> {
    const chatwootConversationId = payload.id;
    if (chatwootConversationId === undefined || payload.status === undefined) return;

    await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId,
      status: payload.status,
    });
  }
}

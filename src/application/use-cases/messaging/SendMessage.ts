import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import type { ChatwootGateway, ChatwootMessageDto } from '@domain/ports/ChatwootGateway';
import {
  ConversationNotFoundError,
  MessagingWindowExpiredError,
  ChatwootUnavailableError,
} from '@domain/errors/messaging';
import { toChatMessageDto, type ChatMessageDto } from '@application/dto/messaging';

/**
 * SendMessage (F1, design §4, SEND-1/2/3) — reply within the 24h WhatsApp window.
 *
 * `canReply` is read straight from the `Conversation` MIRROR — the cache last set by
 * `GetConversation`'s fetch-on-open or by a webhook upsert — and is NEVER recomputed
 * with local 24h math (decision confirmed by the user, design §4). This also covers
 * "never had an inbound message" for free: the schema defaults `canReply=false` on
 * create, so a conversation with no inbound history reads as closed without any
 * extra branch.
 *
 * Guard order (pinned): 404 → canReply=false → 422 WITHOUT calling Chatwoot (SEND-2)
 * → Chatwoot call; any axios failure → 503 (SEND-3) with NO mirror write.
 */
export class SendMessage {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: ChatMessageRepository,
    private readonly gateway: ChatwootGateway,
  ) {}

  async execute(conversationId: string, content: string): Promise<ChatMessageDto> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    if (!conversation.canReply) {
      throw new MessagingWindowExpiredError(conversationId);
    }

    let sent: ChatwootMessageDto;
    try {
      sent = await this.gateway.sendMessage(conversation.chatwootConversationId, content);
    } catch {
      throw new ChatwootUnavailableError();
    }

    const record = await this.messageRepo.upsertByChatwootMessageId({
      conversationId: conversation.id,
      chatwootMessageId: sent.id,
      // Hardcoded 'outbound': this call ALWAYS represents a message WE just sent,
      // regardless of what the gateway DTO's (inbound-only-nullable) direction says.
      direction: 'outbound',
      content: sent.content,
      senderName: sent.senderName,
      chatwootCreatedAt: sent.createdAt,
    });

    await this.conversationRepo.upsertByChatwootId({
      chatwootConversationId: conversation.chatwootConversationId,
      lastMessageAt: sent.createdAt,
      lastMessagePreview: sent.content,
    });

    return toChatMessageDto(record);
  }
}

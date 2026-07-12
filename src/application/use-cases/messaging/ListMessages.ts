import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import { ConversationNotFoundError } from '@domain/errors/messaging';
import { toChatMessageDto, type ChatMessageDto } from '@application/dto/messaging';

/**
 * ListMessages (F1, design §4/§8, INBOX-3) — full chronological history (ASC,
 * oldest first — sort lives in the repository) mapped to `ChatMessageDto`. No
 * pagination in F1 (design §8: no spec scenario asks for `page=`, a WhatsApp
 * thread is bounded — revisit in F2 if a thread grows enough to justify a cursor).
 */
export class ListMessages {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: ChatMessageRepository,
  ) {}

  async execute(conversationId: string): Promise<ChatMessageDto[]> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    const messages = await this.messageRepo.listByConversation(conversationId);
    return messages.map(toChatMessageDto);
  }
}

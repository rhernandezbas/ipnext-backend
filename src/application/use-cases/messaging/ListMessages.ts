import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import type { ChatMessageAttachmentRepository } from '@domain/ports/ChatMessageAttachmentRepository';
import { ConversationNotFoundError } from '@domain/errors/messaging';
import { toChatMessageDto, type ChatMessageDto, type ChatMessageActor } from '@application/dto/messaging';

/**
 * ListMessages (F1, design §4/§8, INBOX-3) — full chronological history (ASC,
 * oldest first — sort lives in the repository) mapped to `ChatMessageDto`. No
 * pagination in F1 (design §8: no spec scenario asks for `page=`, a WhatsApp
 * thread is bounded — revisit in F2 if a thread grows enough to justify a cursor).
 *
 * messaging-inbox-v2-media (Tanda 1 · MEDIA-4) — `attachmentRepo` is optional (keeps
 * existing 2-arg call sites compiling). When present, attachments for ALL messages of
 * the conversation are fetched in ONE bulk call (`listByMessageIds`, anti-N+1) and
 * merged per-message before mapping to DTO — never a per-row query in the loop.
 */
export class ListMessages {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: ChatMessageRepository,
    private readonly attachmentRepo?: ChatMessageAttachmentRepository,
  ) {}

  /**
   * messaging-inbox-notes (edit/delete) — `actor` OPCIONAL (back-compat con los
   * call-sites de 1 arg): el usuario actual, para computar `canEdit`/`canDelete` por
   * mensaje (autor o supervisor). Las notas soft-deleted SIGUEN en el listado (deleted=true,
   * tombstone) — es el contador el que las excluye, no este listado.
   */
  async execute(conversationId: string, actor?: ChatMessageActor): Promise<ChatMessageDto[]> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    const messages = await this.messageRepo.listByConversation(conversationId);
    if (!this.attachmentRepo || messages.length === 0) {
      return messages.map((m) => toChatMessageDto(m, [], actor));
    }

    const attachments = await this.attachmentRepo.listByMessageIds(messages.map((m) => m.id));
    const byMessageId = new Map<string, typeof attachments>();
    for (const a of attachments) {
      const bucket = byMessageId.get(a.messageId);
      if (bucket) bucket.push(a);
      else byMessageId.set(a.messageId, [a]);
    }

    return messages.map((m) => toChatMessageDto(m, byMessageId.get(m.id) ?? [], actor));
  }
}

/**
 * messaging-inbox (F1, batch B4) — ListMessages (INBOX-3). Full chronological
 * history (ASC), mapped to `ChatMessageDto`, plus the 404 guard shared with
 * GetConversation/SendMessage.
 */
import { ListMessages } from '@application/use-cases/messaging/ListMessages';
import { ConversationNotFoundError } from '@domain/errors/messaging';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryChatMessageAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageAttachmentRepository';

async function makeConversation(conversationRepo: InMemoryConversationRepository) {
  const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1 });
  return conv;
}

describe('ListMessages', () => {
  it('INBOX-3: returns inbound/outbound messages ordered chronologically ASC, mapped to DTO', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const conv = await makeConversation(conversationRepo);

    await messageRepo.upsertByChatwootMessageId({
      conversationId: conv.id,
      chatwootMessageId: 2,
      direction: 'outbound',
      content: 'Segunda respuesta',
      chatwootCreatedAt: '2026-07-10T10:05:00.000Z',
    });
    await messageRepo.upsertByChatwootMessageId({
      conversationId: conv.id,
      chatwootMessageId: 1,
      direction: 'inbound',
      content: 'Primer mensaje',
      chatwootCreatedAt: '2026-07-10T10:00:00.000Z',
    });

    const uc = new ListMessages(conversationRepo, messageRepo);
    const result = await uc.execute(conv.id);

    expect(result).toEqual([
      expect.objectContaining({ direction: 'inbound', content: 'Primer mensaje' }),
      expect.objectContaining({ direction: 'outbound', content: 'Segunda respuesta' }),
    ]);
    // DTO shape — no internal Chatwoot ids exposed as the primary key.
    expect(result[0]).not.toHaveProperty('chatwootMessageId');
    expect(result[0]!.id).toEqual(expect.any(String));
  });

  it('INBOX-3: a conversation without messages yet returns an empty array', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const conv = await makeConversation(conversationRepo);

    const uc = new ListMessages(conversationRepo, messageRepo);
    const result = await uc.execute(conv.id);

    expect(result).toEqual([]);
  });

  it('throws ConversationNotFoundError for an unknown conversation id', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const uc = new ListMessages(conversationRepo, messageRepo);

    await expect(uc.execute('ghost-id')).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  describe('MEDIA-4 — attachments por mensaje (anti-N+1)', () => {
    it('cada mensaje trae SOLO sus propios adjuntos, en un único bulk fetch (listByMessageIds)', async () => {
      const conversationRepo = new InMemoryConversationRepository();
      const messageRepo = new InMemoryChatMessageRepository();
      const attachmentRepo = new InMemoryChatMessageAttachmentRepository();
      const conv = await makeConversation(conversationRepo);

      const msg1 = await messageRepo.upsertByChatwootMessageId({
        conversationId: conv.id, chatwootMessageId: 1, direction: 'inbound', content: '',
        chatwootCreatedAt: '2026-07-10T10:00:00.000Z',
      });
      const msg2 = await messageRepo.upsertByChatwootMessageId({
        conversationId: conv.id, chatwootMessageId: 2, direction: 'inbound', content: 'sin adjuntos',
        chatwootCreatedAt: '2026-07-10T10:05:00.000Z',
      });
      await attachmentRepo.upsertByChatwootAttachmentId({
        messageId: msg1.id, chatwootAttachmentId: 1, fileType: 'image', contentType: 'image/jpeg',
        sourceUrl: 'https://x/1.jpg',
      });

      const listByMessageIdsSpy = jest.spyOn(attachmentRepo, 'listByMessageIds');
      const uc = new ListMessages(conversationRepo, messageRepo, attachmentRepo);
      const result = await uc.execute(conv.id);

      expect(listByMessageIdsSpy).toHaveBeenCalledTimes(1); // ONE bulk call, not one per message
      const dto1 = result.find((m) => m.id === msg1.id)!;
      const dto2 = result.find((m) => m.id === msg2.id)!;
      expect(dto1.attachments).toHaveLength(1);
      expect(dto2.attachments).toEqual([]);
    });

    it('sin attachmentRepo inyectado (compat), attachments viene [] para todos', async () => {
      const conversationRepo = new InMemoryConversationRepository();
      const messageRepo = new InMemoryChatMessageRepository();
      const conv = await makeConversation(conversationRepo);
      await messageRepo.upsertByChatwootMessageId({
        conversationId: conv.id, chatwootMessageId: 1, direction: 'inbound', content: 'hola',
        chatwootCreatedAt: '2026-07-10T10:00:00.000Z',
      });

      const uc = new ListMessages(conversationRepo, messageRepo); // 2-arg ctor, sin attachmentRepo
      const result = await uc.execute(conv.id);

      expect(result[0]!.attachments).toEqual([]);
    });
  });
});

/**
 * messaging-inbox (F1, batch B4) — SendMessage (SEND-1/2/3). `canReply` is read
 * straight from the mirror (cached by the last GetConversation/webhook) — NEVER
 * recomputed with local 24h math (design §4, decision confirmed by the user).
 * Uses `FakeChatwootGateway` (helpers/) instead of mocking axios/Prisma.
 */
import { SendMessage } from '@application/use-cases/messaging/SendMessage';
import { MessagingWindowExpiredError, ChatwootUnavailableError, ConversationNotFoundError } from '@domain/errors/messaging';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';

describe('SendMessage', () => {
  it('SEND-1: canReply=true → calls Chatwoot, upserts the outbound ChatMessage and Conversation preview', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const gateway = new FakeChatwootGateway();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 5, canReply: true });
    gateway.sendMessageResult = {
      id: 900,
      direction: 'outbound',
      content: 'Hola, en que te ayudo?',
      senderName: 'Agente',
      createdAt: '2026-07-11T12:00:00.000Z',
    };

    const uc = new SendMessage(conversationRepo, messageRepo, gateway);
    const result = await uc.execute(conv.id, 'Hola, en que te ayudo?');

    expect(result).toEqual(
      expect.objectContaining({ direction: 'outbound', content: 'Hola, en que te ayudo?' }),
    );
    expect(gateway.sendMessageCalls).toEqual([{ chatwootConversationId: 5, content: 'Hola, en que te ayudo?' }]);

    const messages = await messageRepo.listByConversation(conv.id);
    expect(messages).toHaveLength(1);

    const updatedConv = await conversationRepo.findById(conv.id);
    expect(updatedConv!.lastMessagePreview).toBe('Hola, en que te ayudo?');
  });

  describe('SEND-2 — fuera de ventana', () => {
    it('canReply=false → 422 MessagingWindowExpiredError WITHOUT calling Chatwoot nor touching the mirror', async () => {
      const conversationRepo = new InMemoryConversationRepository();
      const messageRepo = new InMemoryChatMessageRepository();
      const gateway = new FakeChatwootGateway();
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 6, canReply: false });

      const uc = new SendMessage(conversationRepo, messageRepo, gateway);
      await expect(uc.execute(conv.id, 'tarde')).rejects.toBeInstanceOf(MessagingWindowExpiredError);

      expect(gateway.sendMessageCalls).toHaveLength(0);
      const messages = await messageRepo.listByConversation(conv.id);
      expect(messages).toHaveLength(0);
    });

    it('a conversation that never had an inbound message defaults canReply=false → 422', async () => {
      const conversationRepo = new InMemoryConversationRepository();
      const messageRepo = new InMemoryChatMessageRepository();
      const gateway = new FakeChatwootGateway();
      // canReply defaults to false on create (schema default, design §1) — never set explicitly.
      const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 7 });

      const uc = new SendMessage(conversationRepo, messageRepo, gateway);
      await expect(uc.execute(conv.id, 'hola?')).rejects.toBeInstanceOf(MessagingWindowExpiredError);
      expect(gateway.sendMessageCalls).toHaveLength(0);
    });
  });

  it('SEND-3: Chatwoot unreachable while sending → 503 ChatwootUnavailableError, no upsert', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const gateway = new FakeChatwootGateway();
    gateway.failSendMessage = true;
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 8, canReply: true });

    const uc = new SendMessage(conversationRepo, messageRepo, gateway);
    await expect(uc.execute(conv.id, 'hola')).rejects.toBeInstanceOf(ChatwootUnavailableError);

    const messages = await messageRepo.listByConversation(conv.id);
    expect(messages).toHaveLength(0);
    const updatedConv = await conversationRepo.findById(conv.id);
    expect(updatedConv!.lastMessagePreview).toBeNull();
  });

  it('throws ConversationNotFoundError for an unknown conversation id', async () => {
    const conversationRepo = new InMemoryConversationRepository();
    const messageRepo = new InMemoryChatMessageRepository();
    const gateway = new FakeChatwootGateway();
    const uc = new SendMessage(conversationRepo, messageRepo, gateway);

    await expect(uc.execute('ghost-id', 'hola')).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

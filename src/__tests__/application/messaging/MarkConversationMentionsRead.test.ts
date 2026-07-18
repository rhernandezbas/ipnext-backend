/**
 * note-mentions (Ola 6b) — MarkConversationMentionsRead: marca leídas (readAt=now) las
 * @menciones del user ACTUAL en una conversación, para que salga de su vista "Menciones".
 * Adapters in-memory (jamás mockear Prisma).
 */
import { MarkConversationMentionsRead } from '@application/use-cases/messaging/MarkConversationMentionsRead';
import { ConversationNotFoundError } from '@domain/errors/messaging';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryConversationMentionRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationMentionRepository';

async function seed() {
  const conversationRepo = new InMemoryConversationRepository();
  const mentionRepo = new InMemoryConversationMentionRepository();
  conversationRepo.linkMentions(mentionRepo);
  const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1 });
  return { conversationRepo, mentionRepo, conv };
}

describe('MarkConversationMentionsRead (note-mentions Ola 6b)', () => {
  it('marca leídas las menciones NO leídas del user actual y devuelve cuántas marcó', async () => {
    const { conversationRepo, mentionRepo, conv } = await seed();
    await mentionRepo.record({ conversationId: conv.id, messageId: 'm1', mentionedUserId: 'user-1' });
    await mentionRepo.record({ conversationId: conv.id, messageId: 'm2', mentionedUserId: 'user-1' });
    const uc = new MarkConversationMentionsRead(conversationRepo, mentionRepo);

    const result = await uc.execute(conv.id, 'user-1');

    expect(result).toEqual({ markedRead: 2 });
    const mentions = await mentionRepo.listByConversation(conv.id);
    expect(mentions.every((m) => m.readAt !== null)).toBe(true);
  });

  it('NO toca las menciones de OTRO usuario', async () => {
    const { conversationRepo, mentionRepo, conv } = await seed();
    await mentionRepo.record({ conversationId: conv.id, messageId: 'm1', mentionedUserId: 'user-1' });
    await mentionRepo.record({ conversationId: conv.id, messageId: 'm1', mentionedUserId: 'user-2' });
    const uc = new MarkConversationMentionsRead(conversationRepo, mentionRepo);

    const result = await uc.execute(conv.id, 'user-1');

    expect(result.markedRead).toBe(1);
    const otherStillUnread = mentionRepo.hasUnreadMention(conv.id, 'user-2');
    expect(otherStillUnread).toBe(true);
  });

  it('idempotente: una segunda llamada no re-marca nada (0)', async () => {
    const { conversationRepo, mentionRepo, conv } = await seed();
    await mentionRepo.record({ conversationId: conv.id, messageId: 'm1', mentionedUserId: 'user-1' });
    const uc = new MarkConversationMentionsRead(conversationRepo, mentionRepo);

    expect((await uc.execute(conv.id, 'user-1')).markedRead).toBe(1);
    expect((await uc.execute(conv.id, 'user-1')).markedRead).toBe(0);
  });

  it('conversación inexistente → ConversationNotFoundError (404)', async () => {
    const { conversationRepo, mentionRepo } = await seed();
    const uc = new MarkConversationMentionsRead(conversationRepo, mentionRepo);

    await expect(uc.execute('ghost-id', 'user-1')).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

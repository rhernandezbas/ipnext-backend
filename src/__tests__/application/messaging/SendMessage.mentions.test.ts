/**
 * note-mentions (Ola 6b) — SendMessage registra @menciones de una nota interna (BEST-EFFORT).
 * Formato del token: `@[Display Name](userId)` (ver `parseMentions`). Se registra una
 * `ConversationMention` por cada userId VÁLIDO (existe en RbacUser vía el lookup), saltando
 * auto-menciones. Un fallo al registrar menciones NUNCA tumba la creación de la nota (misma
 * disciplina que los eventos/attachments). Todo con adapters in-memory (jamás mockear Prisma).
 */
import { SendMessage } from '@application/use-cases/messaging/SendMessage';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryChatMessageAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageAttachmentRepository';
import { InMemoryConversationMentionRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationMentionRepository';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';
import type { EntityLookup } from '@domain/ports/EntityLookup';
import type { ConversationMentionRepository } from '@domain/ports/ConversationMentionRepository';

const KNOWN_USERS = new Set(['user-1', 'user-2', 'user-3']);

function makeUserLookup(known: Set<string> = KNOWN_USERS): EntityLookup {
  return { findById: async (id: string) => (known.has(id) ? { id } : null) };
}

function makeHarness(mentionRepoOverride?: ConversationMentionRepository) {
  const conversationRepo = new InMemoryConversationRepository();
  const messageRepo = new InMemoryChatMessageRepository();
  messageRepo.linkConversationRepo(conversationRepo);
  const gateway = new FakeChatwootGateway();
  const attachmentRepo = new InMemoryChatMessageAttachmentRepository();
  const mentionRepo = mentionRepoOverride ?? new InMemoryConversationMentionRepository();
  conversationRepo.linkMentions(mentionRepo as unknown as InMemoryConversationMentionRepository);
  const uc = new SendMessage(
    conversationRepo,
    messageRepo,
    gateway,
    attachmentRepo,
    undefined,
    mentionRepo,
    makeUserLookup(),
  );
  return { conversationRepo, messageRepo, gateway, attachmentRepo, mentionRepo, uc };
}

/** Echo de Chatwoot para la nota (una nota igual pasa por gateway.sendMessage con private:true). */
function stubEcho(gateway: FakeChatwootGateway, content: string) {
  gateway.sendMessageResult = {
    id: 900,
    direction: 'outbound',
    content,
    senderName: 'Agente Uno',
    createdAt: '2026-07-17T12:00:00.000Z',
  };
}

describe('SendMessage — @menciones en notas internas (note-mentions Ola 6b)', () => {
  it('formato válido → registra una ConversationMention (readAt null, sobre la nota creada, con autor)', async () => {
    const { conversationRepo, gateway, mentionRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1, canReply: false });
    stubEcho(gateway, 'ojo con esto @[Ana](user-2)');

    const dto = await uc.execute(conv.id, 'ojo con esto @[Ana](user-2)', [], true, 'user-1');

    const mentions = await mentionRepo.listByConversation(conv.id);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toEqual(
      expect.objectContaining({
        conversationId: conv.id,
        messageId: dto.id,
        mentionedUserId: 'user-2',
        mentionedByUserId: 'user-1',
        readAt: null,
      }),
    );
  });

  it('texto con "@" que NO es token (email / mención suelta) → NO registra menciones', async () => {
    const { conversationRepo, gateway, mentionRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 2, canReply: false });
    stubEcho(gateway, 'escribile a juan@empresa.com o avisale a @juan');

    await uc.execute(conv.id, 'escribile a juan@empresa.com o avisale a @juan', [], true, 'user-1');

    expect(await mentionRepo.listByConversation(conv.id)).toHaveLength(0);
  });

  it('userId inexistente en RbacUser → se ignora (el lookup devuelve null)', async () => {
    const { conversationRepo, gateway, mentionRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 3, canReply: false });
    stubEcho(gateway, 'ping a @[Fantasma](ghost-id)');

    await uc.execute(conv.id, 'ping a @[Fantasma](ghost-id)', [], true, 'user-1');

    expect(await mentionRepo.listByConversation(conv.id)).toHaveLength(0);
  });

  it('múltiples menciones válidas → una fila por usuario', async () => {
    const { conversationRepo, gateway, mentionRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 4, canReply: false });
    stubEcho(gateway, '@[Ana](user-2) y @[Beto](user-3) miren esto');

    await uc.execute(conv.id, '@[Ana](user-2) y @[Beto](user-3) miren esto', [], true, 'user-1');

    const mentions = await mentionRepo.listByConversation(conv.id);
    expect(mentions.map((m) => m.mentionedUserId).sort()).toEqual(['user-2', 'user-3']);
  });

  it('auto-mención (el autor se nombra a sí mismo) → NO se registra', async () => {
    const { conversationRepo, gateway, mentionRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 5, canReply: false });
    stubEcho(gateway, 'nota para mí @[Yo](user-1)');

    await uc.execute(conv.id, 'nota para mí @[Yo](user-1)', [], true, 'user-1');

    expect(await mentionRepo.listByConversation(conv.id)).toHaveLength(0);
  });

  it('mensaje PÚBLICO (no nota) con un token de mención → NO registra (las menciones son sólo de notas)', async () => {
    const { conversationRepo, gateway, mentionRepo, uc } = makeHarness();
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 6, canReply: true });
    stubEcho(gateway, 'hola @[Ana](user-2)');

    // isPrivate=false → mensaje público, jamás registra menciones.
    await uc.execute(conv.id, 'hola @[Ana](user-2)', [], false, 'user-1');

    expect(await mentionRepo.listByConversation(conv.id)).toHaveLength(0);
  });

  it('BEST-EFFORT: si el repo de menciones FALLA, la nota se crea igual (no propaga)', async () => {
    const failingMentionRepo: ConversationMentionRepository = {
      record: async () => {
        throw new Error('db down');
      },
      markReadForUser: async () => 0,
      listByConversation: async () => [],
    };
    const { conversationRepo, messageRepo, gateway, uc } = makeHarness(failingMentionRepo);
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 7, canReply: false });
    stubEcho(gateway, 'igual sale @[Ana](user-2)');

    // NO rechaza: la nota YA se persistió y el echo YA salió; el fallo del registro se traga.
    const dto = await uc.execute(conv.id, 'igual sale @[Ana](user-2)', [], true, 'user-1');

    expect(dto.private).toBe(true);
    const messages = await messageRepo.listByConversation(conv.id);
    expect(messages).toHaveLength(1);
  });
});

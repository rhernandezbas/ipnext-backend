/**
 * inbox-views (Ola 1, VIEW-1) — adapter intention test con Prisma mockeado (molde
 * `PrismaChatMessageRepository.upsertTemplateMessage.test.ts`). Pinea el
 * mantenimiento del cache desnormalizado `Conversation.lastPublicMessageDirection`
 * en el CHOKE POINT de escritura de mensajes: los 3 upserts del adapter recomputan
 * el último mensaje NO-privado (`findFirst` por `[conversationId, chatwootCreatedAt]`
 * DESC + id DESC — mismo orden invertido que `listByConversation` ASC y mismo
 * criterio que el `DISTINCT ON` del backfill de la migración) y lo escriben en la
 * Conversation. Sin esto la vista "Sin atender" muere EN SILENCIO en prod (lección
 * W6: los tests in-memory solos no detectan un adapter Prisma que no mantiene el
 * cache). Cross-ref: `InMemoryChatMessageRepository.syncConversationDirection` —
 * ambos adapters NO pueden divergir.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    chatMessage: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    conversation: {
      update: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaChatMessageRepository } from '../../infrastructure/adapters/prisma/PrismaChatMessageRepository';

const mockPrisma = prisma as unknown as {
  chatMessage: { upsert: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock };
  conversation: { update: jest.Mock };
};

const UPSERTED_ROW = {
  id: 'msg-1',
  conversationId: 'conv-1',
  chatwootMessageId: 100,
  origin: 'chatwoot',
  campaignRecipientId: null,
  providerMessageId: null,
  direction: 'inbound',
  content: 'hola',
  senderName: 'Cliente',
  chatwootCreatedAt: new Date('2026-07-15T10:00:00.000Z'),
  createdAt: new Date('2026-07-15T10:00:00.000Z'),
  isPrivate: false,
};

describe('PrismaChatMessageRepository — sync de lastPublicMessageDirection (VIEW-1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.chatMessage.upsert.mockResolvedValue(UPSERTED_ROW);
    mockPrisma.conversation.update.mockResolvedValue({});
  });

  it('upsertByChatwootMessageId → recompute del último NO-privado (findFirst DESC+id DESC) y update de la Conversation', async () => {
    mockPrisma.chatMessage.findFirst.mockResolvedValue({ direction: 'inbound' });

    const repo = new PrismaChatMessageRepository();
    await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 100,
      direction: 'inbound',
      content: 'hola',
      chatwootCreatedAt: '2026-07-15T10:00:00.000Z',
    });

    const findFirstCall = mockPrisma.chatMessage.findFirst.mock.calls[0][0];
    expect(findFirstCall.where).toEqual({ conversationId: 'conv-1', isPrivate: false });
    expect(findFirstCall.orderBy).toEqual([{ chatwootCreatedAt: 'desc' }, { id: 'desc' }]);

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { lastPublicMessageDirection: 'inbound' },
    });
  });

  it('el recompute usa lo que la DB dice, no el input: nota privada tras un inbound → el cache queda inbound', async () => {
    // El write es una nota PRIVADA outbound, pero el último NO-privado en DB
    // sigue siendo el inbound del cliente — findFirst (isPrivate:false) lo trae.
    mockPrisma.chatMessage.upsert.mockResolvedValue({ ...UPSERTED_ROW, id: 'msg-2', direction: 'outbound', isPrivate: true });
    mockPrisma.chatMessage.findFirst.mockResolvedValue({ direction: 'inbound' });

    const repo = new PrismaChatMessageRepository();
    await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 101,
      direction: 'outbound',
      content: 'nota interna',
      chatwootCreatedAt: '2026-07-15T10:10:00.000Z',
      isPrivate: true,
    });

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { lastPublicMessageDirection: 'inbound' },
    });
  });

  it('sin ningún mensaje público (findFirst null) → cache a null', async () => {
    mockPrisma.chatMessage.findFirst.mockResolvedValue(null);

    const repo = new PrismaChatMessageRepository();
    await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 102,
      direction: 'outbound',
      content: 'solo nota',
      chatwootCreatedAt: '2026-07-15T10:00:00.000Z',
      isPrivate: true,
    });

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { lastPublicMessageDirection: null },
    });
  });

  it('upsertBulkMessage también sincroniza (bulk = outbound público)', async () => {
    mockPrisma.chatMessage.upsert.mockResolvedValue({
      ...UPSERTED_ROW,
      id: 'msg-3',
      chatwootMessageId: null,
      origin: 'bulk',
      campaignRecipientId: 'rec-1',
      direction: 'outbound',
    });
    mockPrisma.chatMessage.findFirst.mockResolvedValue({ direction: 'outbound' });

    const repo = new PrismaChatMessageRepository();
    await repo.upsertBulkMessage({
      conversationId: 'conv-1',
      campaignRecipientId: 'rec-1',
      content: 'campaña',
      chatwootCreatedAt: '2026-07-15T11:00:00.000Z',
    });

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { lastPublicMessageDirection: 'outbound' },
    });
  });

  it('upsertTemplateMessage también sincroniza (template = outbound público)', async () => {
    mockPrisma.chatMessage.upsert.mockResolvedValue({
      ...UPSERTED_ROW,
      id: 'msg-4',
      chatwootMessageId: null,
      origin: 'agent_template',
      providerMessageId: 'SM123',
      direction: 'outbound',
    });
    mockPrisma.chatMessage.findFirst.mockResolvedValue({ direction: 'outbound' });

    const repo = new PrismaChatMessageRepository();
    await repo.upsertTemplateMessage({
      conversationId: 'conv-1',
      providerMessageId: 'SM123',
      content: 'template',
      chatwootCreatedAt: '2026-07-15T12:00:00.000Z',
    });

    expect(mockPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { lastPublicMessageDirection: 'outbound' },
    });
  });
});

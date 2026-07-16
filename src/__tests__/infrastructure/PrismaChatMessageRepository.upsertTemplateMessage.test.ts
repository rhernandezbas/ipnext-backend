/**
 * inbox-template-send (PORT-1, T7) — adapter intention test with a mocked Prisma
 * client (molde `PrismaChatMessageRepository.orderBy.test.ts`). Pins the shape
 * `upsertTemplateMessage` sends to `prisma.chatMessage.upsert`: `where` por
 * `providerMessageId` (idempotencia), `create` con
 * `origin:'agent_template'`/`direction:'outbound'`/`chatwootMessageId:null`/
 * `campaignRecipientId:null` — misma semántica que
 * `InMemoryChatMessageRepository.upsertTemplateMessage`, que ambos adapters NO
 * pueden divergir.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    chatMessage: {
      upsert: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaChatMessageRepository } from '../../infrastructure/adapters/prisma/PrismaChatMessageRepository';

const mockPrisma = prisma as unknown as {
  chatMessage: { upsert: jest.Mock };
};

describe('PrismaChatMessageRepository — upsertTemplateMessage (PORT-1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('upsert: where por providerMessageId, create con origin agent_template/outbound/sin chatwootMessageId ni campaignRecipientId', async () => {
    mockPrisma.chatMessage.upsert.mockResolvedValue({
      id: 'msg-1',
      conversationId: 'conv-1',
      chatwootMessageId: null,
      origin: 'agent_template',
      campaignRecipientId: null,
      providerMessageId: 'SM123',
      direction: 'outbound',
      content: 'Hola Juan, debés $5.000',
      senderName: 'agente1',
      chatwootCreatedAt: new Date('2026-07-16T10:00:00.000Z'),
      createdAt: new Date('2026-07-16T10:00:00.000Z'),
      isPrivate: false,
    });

    const repo = new PrismaChatMessageRepository();
    const result = await repo.upsertTemplateMessage({
      conversationId: 'conv-1',
      providerMessageId: 'SM123',
      content: 'Hola Juan, debés $5.000',
      senderName: 'agente1',
      chatwootCreatedAt: '2026-07-16T10:00:00.000Z',
    });

    const call = mockPrisma.chatMessage.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ providerMessageId: 'SM123' });
    expect(call.create).toEqual(
      expect.objectContaining({
        conversationId: 'conv-1',
        chatwootMessageId: null,
        origin: 'agent_template',
        campaignRecipientId: null,
        providerMessageId: 'SM123',
        direction: 'outbound',
        content: 'Hola Juan, debés $5.000',
        isPrivate: false,
      }),
    );
    expect(result.origin).toBe('agent_template');
    expect(result.providerMessageId).toBe('SM123');
  });
});

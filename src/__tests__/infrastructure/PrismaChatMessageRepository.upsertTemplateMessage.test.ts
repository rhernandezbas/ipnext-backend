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
      findUnique: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaChatMessageRepository } from '../../infrastructure/adapters/prisma/PrismaChatMessageRepository';

const mockPrisma = prisma as unknown as {
  chatMessage: { upsert: jest.Mock; findUnique: jest.Mock };
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

  describe('H1 (fix wave, idempotency-key server-side)', () => {
    it('create incluye idempotencyKey cuando el input lo trae', async () => {
      mockPrisma.chatMessage.upsert.mockResolvedValue({
        id: 'msg-2',
        conversationId: 'conv-1',
        chatwootMessageId: null,
        origin: 'agent_template',
        campaignRecipientId: null,
        providerMessageId: 'SM124',
        idempotencyKey: 'idem-1',
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
        providerMessageId: 'SM124',
        content: 'Hola Juan, debés $5.000',
        senderName: 'agente1',
        chatwootCreatedAt: '2026-07-16T10:00:00.000Z',
        idempotencyKey: 'idem-1',
      });

      const call = mockPrisma.chatMessage.upsert.mock.calls[0][0];
      expect(call.create).toEqual(expect.objectContaining({ idempotencyKey: 'idem-1' }));
      expect(result.idempotencyKey).toBe('idem-1');
    });

    it('idempotencyKey ausente → create manda null (comportamiento actual)', async () => {
      mockPrisma.chatMessage.upsert.mockResolvedValue({
        id: 'msg-3',
        conversationId: 'conv-1',
        chatwootMessageId: null,
        origin: 'agent_template',
        campaignRecipientId: null,
        providerMessageId: 'SM125',
        idempotencyKey: null,
        direction: 'outbound',
        content: 'Hola',
        senderName: null,
        chatwootCreatedAt: new Date('2026-07-16T10:00:00.000Z'),
        createdAt: new Date('2026-07-16T10:00:00.000Z'),
        isPrivate: false,
      });

      const repo = new PrismaChatMessageRepository();
      await repo.upsertTemplateMessage({
        conversationId: 'conv-1',
        providerMessageId: 'SM125',
        content: 'Hola',
        chatwootCreatedAt: '2026-07-16T10:00:00.000Z',
      });

      const call = mockPrisma.chatMessage.upsert.mock.calls[0][0];
      expect(call.create).toEqual(expect.objectContaining({ idempotencyKey: null }));
    });

    it('backstop de carrera: el upsert choca el @unique de idempotencyKey (P2002) → recupera la fila ganadora por findByIdempotencyKey en vez de propagar', async () => {
      mockPrisma.chatMessage.upsert.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
          meta: { target: ['idempotencyKey'] },
        }),
      );
      mockPrisma.chatMessage.findUnique.mockResolvedValue({
        id: 'msg-winner',
        conversationId: 'conv-1',
        chatwootMessageId: null,
        origin: 'agent_template',
        campaignRecipientId: null,
        providerMessageId: 'SM-race-A',
        idempotencyKey: 'idem-race',
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
        providerMessageId: 'SM-race-B',
        content: 'segundo intento (perdedor)',
        chatwootCreatedAt: '2026-07-16T10:00:00.000Z',
        idempotencyKey: 'idem-race',
      });

      expect(mockPrisma.chatMessage.findUnique).toHaveBeenCalledWith({ where: { idempotencyKey: 'idem-race' } });
      expect(result.id).toBe('msg-winner');
      expect(result.providerMessageId).toBe('SM-race-A');
    });

    it('un P2002 en OTRA columna (no idempotencyKey) o sin idempotencyKey en el input propaga tal cual (no lo absorbe por error)', async () => {
      mockPrisma.chatMessage.upsert.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), {
          code: 'P2002',
          meta: { target: ['providerMessageId'] },
        }),
      );

      const repo = new PrismaChatMessageRepository();
      await expect(
        repo.upsertTemplateMessage({
          conversationId: 'conv-1',
          providerMessageId: 'SM126',
          content: 'x',
          chatwootCreatedAt: '2026-07-16T10:00:00.000Z',
          idempotencyKey: 'idem-otra',
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(mockPrisma.chatMessage.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('H1 — findByIdempotencyKey', () => {
    it('resuelve la fila por idempotencyKey', async () => {
      mockPrisma.chatMessage.findUnique.mockResolvedValue({
        id: 'msg-4',
        conversationId: 'conv-1',
        chatwootMessageId: null,
        origin: 'agent_template',
        campaignRecipientId: null,
        providerMessageId: 'SM127',
        idempotencyKey: 'idem-4',
        direction: 'outbound',
        content: 'Hola',
        senderName: null,
        chatwootCreatedAt: new Date('2026-07-16T10:00:00.000Z'),
        createdAt: new Date('2026-07-16T10:00:00.000Z'),
        isPrivate: false,
      });

      const repo = new PrismaChatMessageRepository();
      const result = await repo.findByIdempotencyKey('idem-4');

      expect(mockPrisma.chatMessage.findUnique).toHaveBeenCalledWith({ where: { idempotencyKey: 'idem-4' } });
      expect(result?.id).toBe('msg-4');
    });

    it('sin match → null', async () => {
      mockPrisma.chatMessage.findUnique.mockResolvedValue(null);

      const repo = new PrismaChatMessageRepository();
      expect(await repo.findByIdempotencyKey('nope')).toBeNull();
    });
  });
});

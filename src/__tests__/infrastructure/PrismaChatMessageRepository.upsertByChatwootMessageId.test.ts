/**
 * chatwoot-hub-sendpath (D5, B3.4) — adapter intention test with a mocked Prisma
 * client (molde `PrismaChatMessageRepository.upsertTemplateMessage.test.ts`). Pins
 * que `idempotencyKey` viaja SET-ONCE en `upsertByChatwootMessageId`: el `create`
 * la incluye (o `null` si ausente), el `update` NUNCA la toca — así el eco
 * idempotente del webhook (`message_created`, que no manda la key) jamás la pisa.
 * Misma semántica que `InMemoryChatMessageRepository.upsertByChatwootMessageId`,
 * ambos adapters NO pueden divergir.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    chatMessage: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
    },
    $executeRaw: jest.fn(),
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaChatMessageRepository } from '../../infrastructure/adapters/prisma/PrismaChatMessageRepository';

const mockPrisma = prisma as unknown as {
  chatMessage: { upsert: jest.Mock; findUnique: jest.Mock };
  $executeRaw: jest.Mock;
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    chatwootMessageId: 555,
    origin: 'chatwoot',
    campaignRecipientId: null,
    providerMessageId: null,
    idempotencyKey: null,
    direction: 'outbound',
    content: 'Hola Juan, debés $5.000',
    senderName: null,
    chatwootCreatedAt: new Date('2026-07-21T10:00:00.000Z'),
    createdAt: new Date('2026-07-21T10:00:00.000Z'),
    isPrivate: false,
    authorId: null,
    editedAt: null,
    deletedAt: null,
    deliveryStatus: null,
    deliveryError: null,
    ...overrides,
  };
}

describe('PrismaChatMessageRepository — upsertByChatwootMessageId (D5, idempotencyKey set-once)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('create incluye idempotencyKey cuando el input lo trae', async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(null); // sin edición local previa
    mockPrisma.chatMessage.upsert.mockResolvedValue(row({ idempotencyKey: 'idem-1' }));

    const repo = new PrismaChatMessageRepository();
    const result = await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 555,
      direction: 'outbound',
      content: 'Hola Juan, debés $5.000',
      chatwootCreatedAt: '2026-07-21T10:00:00.000Z',
      idempotencyKey: 'idem-1',
    });

    const call = mockPrisma.chatMessage.upsert.mock.calls[0][0];
    expect(call.create).toEqual(expect.objectContaining({ idempotencyKey: 'idem-1' }));
    expect(result.idempotencyKey).toBe('idem-1');
  });

  it('idempotencyKey ausente en el create → manda null explícito', async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(null);
    mockPrisma.chatMessage.upsert.mockResolvedValue(row());

    const repo = new PrismaChatMessageRepository();
    await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 555,
      direction: 'outbound',
      content: 'Hola Juan, debés $5.000',
      chatwootCreatedAt: '2026-07-21T10:00:00.000Z',
    });

    const call = mockPrisma.chatMessage.upsert.mock.calls[0][0];
    expect(call.create).toEqual(expect.objectContaining({ idempotencyKey: null }));
  });

  it('el `update` NUNCA incluye idempotencyKey cuando el INPUT no la trae (eco del webhook, set-once)', async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue(null);
    mockPrisma.chatMessage.upsert.mockResolvedValue(row({ content: 'echo', idempotencyKey: 'idem-1' }));

    const repo = new PrismaChatMessageRepository();
    await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 555,
      direction: 'outbound',
      content: 'echo',
      chatwootCreatedAt: '2026-07-21T10:05:00.000Z',
      // sin idempotencyKey — simula el eco de message_created del webhook.
    });

    const call = mockPrisma.chatMessage.upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty('idempotencyKey');
  });

  // F1 (fix wave) — SET-ONCE-IF-NULL: cuando la fila EXISTENTE tiene idempotencyKey null y el
  // INPUT trae una (el use case ON upsertea tras un eco que ganó la carrera y creó la fila sin
  // key), el UPDATE debe setearla. El pre-read (findUnique) informa el estado actual de la key.
  it('el `update` SÍ incluye idempotencyKey cuando la fila existente la tiene null y el input trae una (set-once-if-null)', async () => {
    // pre-read: fila existente SIN key ni edición local
    mockPrisma.chatMessage.findUnique.mockResolvedValue({ editedAt: null, idempotencyKey: null });
    mockPrisma.chatMessage.upsert.mockResolvedValue(row({ idempotencyKey: 'idem-set-once' }));

    const repo = new PrismaChatMessageRepository();
    await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 555,
      direction: 'outbound',
      content: 'Hola Juan, debés $5.000',
      chatwootCreatedAt: '2026-07-21T10:05:00.000Z',
      idempotencyKey: 'idem-set-once',
    });

    const call = mockPrisma.chatMessage.upsert.mock.calls[0][0];
    expect(call.update).toEqual(expect.objectContaining({ idempotencyKey: 'idem-set-once' }));
  });

  it('el `update` NO incluye idempotencyKey cuando la fila existente YA tiene una (nunca la pisa)', async () => {
    // pre-read: fila existente CON key
    mockPrisma.chatMessage.findUnique.mockResolvedValue({ editedAt: null, idempotencyKey: 'idem-vieja' });
    mockPrisma.chatMessage.upsert.mockResolvedValue(row({ idempotencyKey: 'idem-vieja' }));

    const repo = new PrismaChatMessageRepository();
    await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 555,
      direction: 'outbound',
      content: 'x',
      chatwootCreatedAt: '2026-07-21T10:05:00.000Z',
      idempotencyKey: 'idem-nueva',
    });

    const call = mockPrisma.chatMessage.upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty('idempotencyKey');
  });

  // F1 (fix wave) — carrera del @unique(idempotencyKey): dos requests concurrentes con la MISMA
  // key pero DISTINTO chatwootMessageId → el CREATE choca P2002 en idempotencyKey. En vez de
  // propagar un 500, se recupera la fila GANADORA por findByIdempotencyKey (mismo patrón que
  // upsertTemplateMessage). Cualquier OTRO error (incluido un P2002 en otra columna) propaga.
  it('P2002 en idempotencyKey en el CREATE → recupera la fila ganadora por findByIdempotencyKey (no 500)', async () => {
    mockPrisma.chatMessage.findUnique
      .mockResolvedValueOnce({ editedAt: null, idempotencyKey: null }) // pre-read
      .mockResolvedValueOnce(row({ chatwootMessageId: 700, idempotencyKey: 'idem-race' })); // recovery winner
    mockPrisma.chatMessage.upsert.mockRejectedValue({ code: 'P2002', meta: { target: ['idempotencyKey'] } });

    const repo = new PrismaChatMessageRepository();
    const result = await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 701,
      direction: 'outbound',
      content: 'x',
      chatwootCreatedAt: '2026-07-21T10:05:00.000Z',
      idempotencyKey: 'idem-race',
    });

    expect(result.chatwootMessageId).toBe(700); // la ganadora
    expect(result.idempotencyKey).toBe('idem-race');
  });

  it('un P2002 en OTRA columna (no idempotencyKey) propaga tal cual', async () => {
    mockPrisma.chatMessage.findUnique.mockResolvedValue({ editedAt: null, idempotencyKey: null });
    mockPrisma.chatMessage.upsert.mockRejectedValue({ code: 'P2002', meta: { target: ['chatwootMessageId'] } });

    const repo = new PrismaChatMessageRepository();
    await expect(
      repo.upsertByChatwootMessageId({
        conversationId: 'conv-1',
        chatwootMessageId: 555,
        direction: 'outbound',
        content: 'x',
        chatwootCreatedAt: '2026-07-21T10:05:00.000Z',
        idempotencyKey: 'idem-x',
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

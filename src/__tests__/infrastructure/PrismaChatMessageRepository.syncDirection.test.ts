/**
 * inbox-views (Ola 1, VIEW-1 + fix wave M1/M2/L2) — adapter intention test con
 * Prisma mockeado (molde `PrismaChatMessageRepository.upsertTemplateMessage.test.ts`).
 * Pinea el mantenimiento del cache desnormalizado
 * `Conversation.lastPublicMessageDirection` en el CHOKE POINT de escritura de
 * mensajes (los 3 upserts del adapter):
 *
 * - M1 (ATÓMICO): el recompute es UN SOLO statement `$executeRaw` (CTE del último
 *   mensaje NO-privado por chatwootCreatedAt DESC, id DESC + UPDATE) — snapshot
 *   consistente, SIN ventana read→write entre un findFirst y un update separados
 *   (el interleaving webhook inbound ↔ send del agente dejaba la columna stale).
 *   Se pinea que conversation.update (la versión en 2 statements) NO se llama.
 * - M2 (FAIL-OPEN): el sync corre DESPUÉS de que el ChatMessage commiteó (y en
 *   SendMessage el WhatsApp real YA salió) — su fallo JAMÁS puede fallar el
 *   upsert (500 → retry manual = mensaje DUPLICADO al cliente, el send normal no
 *   tiene idempotency key). try/catch + console.error, mismo criterio fail-open
 *   que maybeRegisterOptOut/captureAttachments. El cache self-heals en el
 *   próximo write de la conversación.
 * - L2: `IS DISTINCT FROM` — una nota privada sin cambio real de dirección no
 *   re-escribe la fila (no-op, cero dead tuples).
 *
 * La CORRECCIÓN del resultado con mensajes mixtos (inbound→outbound sale, nota
 * privada posterior NO atiende, sin públicos → null) está cubierta por el espejo
 * in-memory en `ListConversations.unattendedFilter.test.ts` — acá se pinea la
 * FORMA del statement (mismo criterio de "último" que el backfill de la
 * migración). Cross-ref: `InMemoryChatMessageRepository.syncConversationDirection`
 * — ambos adapters NO pueden divergir.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    chatMessage: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
    },
    conversation: {
      // Solo para pinear que la versión NO-atómica (findFirst + update) murió.
      update: jest.fn(),
    },
    $executeRaw: jest.fn(),
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaChatMessageRepository } from '../../infrastructure/adapters/prisma/PrismaChatMessageRepository';

const mockPrisma = prisma as unknown as {
  chatMessage: { upsert: jest.Mock; findUnique: jest.Mock };
  conversation: { update: jest.Mock };
  $executeRaw: jest.Mock;
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

/** Reconstruye el SQL del tagged template (`$executeRaw\`...\``) y sus params. */
function rawCall(callIdx = 0): { sql: string; params: unknown[] } {
  const call = mockPrisma.$executeRaw.mock.calls[callIdx];
  const [strings, ...params] = call as [ReadonlyArray<string>, ...unknown[]];
  return { sql: strings.join(' ¤ '), params };
}

describe('PrismaChatMessageRepository — sync ATÓMICO de lastPublicMessageDirection (M1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.chatMessage.upsert.mockResolvedValue(UPSERTED_ROW);
    mockPrisma.$executeRaw.mockResolvedValue(1);
  });

  it('upsertByChatwootMessageId → UN SOLO statement $executeRaw (CTE último NO-privado + UPDATE + IS DISTINCT FROM), jamás findFirst+update', async () => {
    const repo = new PrismaChatMessageRepository();
    await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 100,
      direction: 'inbound',
      content: 'hola',
      chatwootCreatedAt: '2026-07-15T10:00:00.000Z',
    });

    // M1 — atómico: exactamente UN statement, y la versión en 2 statements
    // (conversation.update) NO existe más.
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();

    const { sql, params } = rawCall();
    // CTE del último mensaje público — MISMO criterio que el backfill de la
    // migración (chatwootCreatedAt DESC, id DESC) y que listByConversation ASC invertido.
    expect(sql).toMatch(/WITH last AS/);
    expect(sql).toMatch(/"isPrivate" = false/);
    expect(sql).toMatch(/ORDER BY m\."chatwootCreatedAt" DESC, m\."id" DESC/);
    expect(sql).toMatch(/LIMIT 1/);
    expect(sql).toMatch(/UPDATE "Conversation"/);
    expect(sql).toMatch(/SET "lastPublicMessageDirection"/);
    // L2 — no-op cuando no hay cambio real (nota privada repetida no re-escribe).
    expect(sql).toMatch(/IS DISTINCT FROM/);
    // Parametrizado (conversationId en el CTE y en el WHERE del UPDATE), nunca interpolado.
    expect(params).toEqual(['conv-1', 'conv-1']);
  });

  it('upsertBulkMessage también sincroniza con el MISMO statement atómico', async () => {
    mockPrisma.chatMessage.upsert.mockResolvedValue({
      ...UPSERTED_ROW,
      id: 'msg-3',
      chatwootMessageId: null,
      origin: 'bulk',
      campaignRecipientId: 'rec-1',
      direction: 'outbound',
    });

    const repo = new PrismaChatMessageRepository();
    await repo.upsertBulkMessage({
      conversationId: 'conv-9',
      campaignRecipientId: 'rec-1',
      content: 'campaña',
      chatwootCreatedAt: '2026-07-15T11:00:00.000Z',
    });

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
    const { sql, params } = rawCall();
    expect(sql).toMatch(/UPDATE "Conversation"/);
    expect(params).toEqual(['conv-9', 'conv-9']);
  });

  it('upsertTemplateMessage también sincroniza con el MISMO statement atómico', async () => {
    mockPrisma.chatMessage.upsert.mockResolvedValue({
      ...UPSERTED_ROW,
      id: 'msg-4',
      chatwootMessageId: null,
      origin: 'agent_template',
      providerMessageId: 'SM123',
      direction: 'outbound',
    });

    const repo = new PrismaChatMessageRepository();
    await repo.upsertTemplateMessage({
      conversationId: 'conv-1',
      providerMessageId: 'SM123',
      content: 'template',
      chatwootCreatedAt: '2026-07-15T12:00:00.000Z',
    });

    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.conversation.update).not.toHaveBeenCalled();
    expect(rawCall().params).toEqual(['conv-1', 'conv-1']);
  });
});

describe('PrismaChatMessageRepository — sync FAIL-OPEN (M2: su fallo jamás falla el write ya commiteado)', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.chatMessage.upsert.mockResolvedValue(UPSERTED_ROW);
    mockPrisma.$executeRaw.mockRejectedValue(new Error('deadlock detected'));
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('upsertByChatwootMessageId: el sync explota → el upsert IGUAL resuelve con la fila (en SendMessage el WhatsApp YA salió — un 500 acá provoca retry = mensaje duplicado) y el error queda logueado', async () => {
    const repo = new PrismaChatMessageRepository();
    const result = await repo.upsertByChatwootMessageId({
      conversationId: 'conv-1',
      chatwootMessageId: 100,
      direction: 'inbound',
      content: 'hola',
      chatwootCreatedAt: '2026-07-15T10:00:00.000Z',
    });

    expect(result.id).toBe('msg-1');
    expect(result.direction).toBe('inbound');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleErrorSpy.mock.calls[0][0])).toMatch(/lastPublicMessageDirection/);
  });

  it('upsertBulkMessage: mismo fail-open', async () => {
    mockPrisma.chatMessage.upsert.mockResolvedValue({
      ...UPSERTED_ROW,
      id: 'msg-3',
      campaignRecipientId: 'rec-1',
      direction: 'outbound',
    });

    const repo = new PrismaChatMessageRepository();
    const result = await repo.upsertBulkMessage({
      conversationId: 'conv-1',
      campaignRecipientId: 'rec-1',
      content: 'campaña',
      chatwootCreatedAt: '2026-07-15T11:00:00.000Z',
    });

    expect(result.id).toBe('msg-3');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('upsertTemplateMessage: mismo fail-open (y el catch del sync NO se confunde con el recovery de carrera P2002)', async () => {
    mockPrisma.chatMessage.upsert.mockResolvedValue({
      ...UPSERTED_ROW,
      id: 'msg-4',
      providerMessageId: 'SM123',
      direction: 'outbound',
    });

    const repo = new PrismaChatMessageRepository();
    const result = await repo.upsertTemplateMessage({
      conversationId: 'conv-1',
      providerMessageId: 'SM123',
      content: 'template',
      chatwootCreatedAt: '2026-07-15T12:00:00.000Z',
    });

    expect(result.id).toBe('msg-4');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    // El fallo del sync jamás dispara el fallback de idempotencia (findUnique).
    expect(mockPrisma.chatMessage.findUnique).not.toHaveBeenCalled();
  });
});

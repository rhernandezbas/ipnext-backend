/**
 * messaging-inbox-notes (F1.5 fase D, NOTE-5) — `toChatMessageDto` MUST expose
 * `private: boolean`, mapeado 1:1 desde `ChatMessageRecord.isPrivate` (rename de
 * wire: `isPrivate` en dominio ↔ `private` en el DTO, mismo nombre que Chatwoot
 * usa en su propio wire). Nunca expone la entidad Prisma cruda.
 */
import { toChatMessageDto } from '@application/dto/messaging';
import type { ChatMessageRecord } from '@domain/ports/ChatMessageRepository';

function record(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    chatwootMessageId: 100,
    origin: 'chatwoot',
    campaignRecipientId: null,
    direction: 'outbound',
    content: 'hola',
    senderName: 'Agente',
    chatwootCreatedAt: '2026-07-11T12:00:00.000Z',
    createdAt: '2026-07-11T12:00:00.000Z',
    isPrivate: false,
    providerMessageId: null,
    idempotencyKey: null,
    ...overrides,
  };
}

describe('toChatMessageDto — NOTE-5 (private)', () => {
  it('mensaje privado (isPrivate:true) → DTO.private === true', () => {
    const dto = toChatMessageDto(record({ isPrivate: true }));

    expect(dto.private).toBe(true);
  });

  it('mensaje normal (isPrivate:false) → DTO.private === false', () => {
    const dto = toChatMessageDto(record({ isPrivate: false }));

    expect(dto.private).toBe(false);
  });
});

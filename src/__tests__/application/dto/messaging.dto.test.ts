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
    authorId: null,
    editedAt: null,
    deletedAt: null,
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

// ─── messaging-inbox-notes (edit/delete) — authorId/edited/deleted + canEdit/canDelete ──

describe('toChatMessageDto — atribución + flags (edit/delete)', () => {
  it('expone authorId, edited=false y deleted=false por default', () => {
    const dto = toChatMessageDto(record({ isPrivate: true, authorId: 'user-1' }));
    expect(dto.authorId).toBe('user-1');
    expect(dto.edited).toBe(false);
    expect(dto.deleted).toBe(false);
  });

  it('editedAt != null → edited=true', () => {
    const dto = toChatMessageDto(record({ isPrivate: true, editedAt: '2026-07-12T00:00:00.000Z' }));
    expect(dto.edited).toBe(true);
  });

  it('nota borrada → deleted=true y content VACÍO (no filtra el texto original)', () => {
    const dto = toChatMessageDto(
      record({ isPrivate: true, content: 'secreto', deletedAt: '2026-07-12T00:00:00.000Z' }),
    );
    expect(dto.deleted).toBe(true);
    expect(dto.content).toBe('');
  });

  describe('canEdit/canDelete contra el actor', () => {
    it('autor (authorId === actor.userId) → canEdit/canDelete true', () => {
      const dto = toChatMessageDto(record({ isPrivate: true, authorId: 'user-1' }), [], { userId: 'user-1' });
      expect(dto.canEdit).toBe(true);
      expect(dto.canDelete).toBe(true);
    });

    it('otro usuario sin manage → canEdit/canDelete false', () => {
      const dto = toChatMessageDto(record({ isPrivate: true, authorId: 'user-1' }), [], { userId: 'user-2' });
      expect(dto.canEdit).toBe(false);
      expect(dto.canDelete).toBe(false);
    });

    it('supervisor (canManage) → canEdit/canDelete true aunque no sea el autor', () => {
      const dto = toChatMessageDto(
        record({ isPrivate: true, authorId: 'user-1' }),
        [],
        { userId: 'user-9', canManage: true },
      );
      expect(dto.canEdit).toBe(true);
      expect(dto.canDelete).toBe(true);
    });

    it('nota con authorId NULL → sólo el supervisor puede (autor desconocido)', () => {
      const asManager = toChatMessageDto(record({ isPrivate: true, authorId: null }), [], { userId: 'x', canManage: true });
      const asUser = toChatMessageDto(record({ isPrivate: true, authorId: null }), [], { userId: 'x' });
      expect(asManager.canEdit).toBe(true);
      expect(asUser.canEdit).toBe(false);
    });

    it('mensaje PÚBLICO (isPrivate:false) nunca es editable, ni para un supervisor', () => {
      const dto = toChatMessageDto(record({ isPrivate: false, authorId: 'user-1' }), [], { userId: 'user-1', canManage: true });
      expect(dto.canEdit).toBe(false);
      expect(dto.canDelete).toBe(false);
    });

    it('nota borrada nunca es editable, ni para el autor', () => {
      const dto = toChatMessageDto(
        record({ isPrivate: true, authorId: 'user-1', deletedAt: '2026-07-12T00:00:00.000Z' }),
        [],
        { userId: 'user-1' },
      );
      expect(dto.canEdit).toBe(false);
      expect(dto.canDelete).toBe(false);
    });

    it('sin actor → canEdit/canDelete false', () => {
      const dto = toChatMessageDto(record({ isPrivate: true, authorId: 'user-1' }));
      expect(dto.canEdit).toBe(false);
      expect(dto.canDelete).toBe(false);
    });
  });
});

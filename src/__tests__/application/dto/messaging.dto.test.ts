/**
 * messaging-inbox-notes (F1.5 fase D, NOTE-5) — `toChatMessageDto` MUST expose
 * `private: boolean`, mapeado 1:1 desde `ChatMessageRecord.isPrivate` (rename de
 * wire: `isPrivate` en dominio ↔ `private` en el DTO, mismo nombre que Chatwoot
 * usa en su propio wire). Nunca expone la entidad Prisma cruda.
 */
import { toChatMessageDto, toPreviousConversationDto } from '@application/dto/messaging';
import type { ChatMessageRecord } from '@domain/ports/ChatMessageRepository';
import type { ConversationRecord } from '@domain/ports/ConversationRepository';

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
    deliveryStatus: null,
    deliveryError: null,
    ...overrides,
  };
}

describe('toChatMessageDto — chatwoot-hub-sendpath (D6) — deliveryStatus/deliveryError', () => {
  it('default (deliveryStatus/deliveryError null) → DTO expone ambos en null', () => {
    const dto = toChatMessageDto(record());
    expect(dto.deliveryStatus).toBeNull();
    expect(dto.deliveryError).toBeNull();
  });

  it("deliveryStatus:'failed' + deliveryError poblado → DTO los expone TAL CUAL (aditivo, D6)", () => {
    const dto = toChatMessageDto(record({ deliveryStatus: 'failed', deliveryError: 'Template not found' }));
    expect(dto.deliveryStatus).toBe('failed');
    expect(dto.deliveryError).toBe('Template not found');
  });
});

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

// ─── previous-conversations (Ola 6a) — toPreviousConversationDto (DTO liviano) ──

function conversationRecord(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conv-1',
    chatwootConversationId: 10,
    origin: 'chatwoot',
    contactName: 'Juan',
    contactPhone: '+5492324421234',
    contactPhoneE164: '+5492324421234',
    status: 'open',
    canReply: true,
    lastMessageAt: '2026-07-11T12:00:00.000Z',
    lastMessagePreview: 'hola',
    assigneeId: 'user-1',
    assigneeName: 'Agente Uno',
    areaId: null,
    areaName: null,
    areaColor: null,
    campaigns: [],
    labels: [{ id: 'l1', name: 'Urgente', color: '#ef4444' }],
    lastPublicMessageDirection: 'inbound',
    internalNoteCount: 0,
    resolvedAt: null,
    firstResolvedAt: null,
    // conversation-snooze (Ola 6c) — campo requerido del record (null = no pospuesta).
    snoozedUntil: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-11T12:00:00.000Z',
    ...overrides,
  };
}

describe('toPreviousConversationDto — previous-conversations (Ola 6a) DTO liviano', () => {
  it('proyecta el subconjunto liviano (id/status/lastMessageAt/lastMessagePreview/assigneeName/unread/labels)', () => {
    const dto = toPreviousConversationDto(conversationRecord());

    expect(dto).toEqual({
      id: 'conv-1',
      status: 'open',
      lastMessageAt: '2026-07-11T12:00:00.000Z',
      lastMessagePreview: 'hola',
      assigneeName: 'Agente Uno',
      unread: true,
      labels: [{ id: 'l1', name: 'Urgente', color: '#ef4444' }],
    });
  });

  it('NO expone campos pesados/crudos del record (chatwootConversationId, contactPhone, canReply, campaigns, internalNoteCount, preview)', () => {
    const dto = toPreviousConversationDto(conversationRecord());

    expect(dto).not.toHaveProperty('chatwootConversationId');
    expect(dto).not.toHaveProperty('contactPhone');
    expect(dto).not.toHaveProperty('contactPhoneE164');
    expect(dto).not.toHaveProperty('canReply');
    expect(dto).not.toHaveProperty('campaigns');
    expect(dto).not.toHaveProperty('internalNoteCount');
    expect(dto).not.toHaveProperty('preview');
  });

  it('unread deriva de lastPublicMessageDirection === "inbound" (el cliente habló último, sin respuesta)', () => {
    expect(toPreviousConversationDto(conversationRecord({ lastPublicMessageDirection: 'inbound' })).unread).toBe(true);
    expect(toPreviousConversationDto(conversationRecord({ lastPublicMessageDirection: 'outbound' })).unread).toBe(false);
    expect(toPreviousConversationDto(conversationRecord({ lastPublicMessageDirection: null })).unread).toBe(false);
  });

  it('assigneeName null cuando no hay asignado; labels [] cuando no tiene', () => {
    const dto = toPreviousConversationDto(conversationRecord({ assigneeId: null, assigneeName: null, labels: [] }));

    expect(dto.assigneeName).toBeNull();
    expect(dto.labels).toEqual([]);
  });
});

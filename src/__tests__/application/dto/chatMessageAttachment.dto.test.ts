/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · B5.1) — DTO de adjunto de chat
 * (spec MEDIA-4, scenarios 16/17). `toChatMessageAttachmentDto`/`toChatMessageDto`
 * NUNCA deben filtrar campos internos (`sourceUrl`/`storageKey`/`thumbStorageKey`/
 * `lastError`/`downloadAttempts`).
 */
import { toChatMessageAttachmentDto, toChatMessageDto } from '@application/dto/messaging';
import type { ChatMessageAttachmentRecord } from '@domain/ports/ChatMessageAttachmentRepository';
import type { ChatMessageRecord } from '@domain/ports/ChatMessageRepository';

function makeRecord(overrides: Partial<ChatMessageAttachmentRecord> = {}): ChatMessageAttachmentRecord {
  return {
    id: 'att-1',
    messageId: 'msg-1',
    chatwootAttachmentId: 42,
    fileType: 'image',
    contentType: 'image/jpeg',
    filename: 'foto.jpg',
    sizeBytes: 5000,
    width: 800,
    height: 600,
    storageKey: 'messaging/conv-1/att-1.jpg',
    thumbStorageKey: 'messaging/conv-1/att-1-thumb.jpg',
    sourceUrl: 'https://chat.ipnext.com.ar/rails/active_storage/blobs/redirect/abc/foto.jpg',
    thumbSourceUrl: 'https://chat.ipnext.com.ar/rails/active_storage/representations/abc/thumb.jpg',
    status: 'downloaded',
    downloadAttempts: 0,
    lastError: 'some old transient error that should never leak',
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:01:00.000Z',
    ...overrides,
  };
}

describe('toChatMessageAttachmentDto (MEDIA-4)', () => {
  it('scenario 16 — NO expone sourceUrl/thumbSourceUrl/storageKey/thumbStorageKey/lastError/downloadAttempts', () => {
    const dto = toChatMessageAttachmentDto(makeRecord());
    const json = JSON.parse(JSON.stringify(dto));

    expect(json).not.toHaveProperty('sourceUrl');
    expect(json).not.toHaveProperty('thumbSourceUrl');
    expect(json).not.toHaveProperty('storageKey');
    expect(json).not.toHaveProperty('thumbStorageKey');
    expect(json).not.toHaveProperty('lastError');
    expect(json).not.toHaveProperty('downloadAttempts');
  });

  it('expone exactamente el contrato: id/fileType/contentType/filename/fileSize/width/height/status/url/thumbUrl', () => {
    const dto = toChatMessageAttachmentDto(makeRecord());
    expect(dto).toEqual({
      id: 'att-1',
      fileType: 'image',
      contentType: 'image/jpeg',
      filename: 'foto.jpg',
      fileSize: 5000,
      width: 800,
      height: 600,
      status: 'downloaded',
      url: '/api/messaging/attachments/att-1/file',
      thumbUrl: '/api/messaging/attachments/att-1/file?variant=thumb',
    });
  });

  it('scenario 17 — thumbUrl es null cuando no hay thumbStorageKey (video/audio/file)', () => {
    const dto = toChatMessageAttachmentDto(makeRecord({ fileType: 'video', thumbStorageKey: null }));
    expect(dto.thumbUrl).toBeNull();
  });

  it('scenario "status expuesto tal cual" — pending/failed viajan sin transformar', () => {
    expect(toChatMessageAttachmentDto(makeRecord({ status: 'pending' })).status).toBe('pending');
    expect(toChatMessageAttachmentDto(makeRecord({ status: 'failed' })).status).toBe('failed');
  });

  it('fileSize es null cuando sizeBytes es null (Chatwoot no lo reportó)', () => {
    expect(toChatMessageAttachmentDto(makeRecord({ sizeBytes: null })).fileSize).toBeNull();
  });
});

describe('toChatMessageDto — attachments (MEDIA-4)', () => {
  function makeMessage(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
    return {
      id: 'msg-1',
      conversationId: 'conv-1',
      chatwootMessageId: 900,
      origin: 'chatwoot',
      campaignRecipientId: null,
      direction: 'inbound',
      content: '',
      senderName: null,
      chatwootCreatedAt: '2026-07-11T00:00:00.000Z',
      createdAt: '2026-07-11T00:00:00.000Z',
      isPrivate: false,
      providerMessageId: null,
      idempotencyKey: null,
      authorId: null,
      editedAt: null,
      deletedAt: null,
      ...overrides,
    };
  }

  it('sin adjuntos (default) → attachments: []', () => {
    const dto = toChatMessageDto(makeMessage());
    expect(dto.attachments).toEqual([]);
  });

  it('con adjuntos → los mapea a ChatMessageAttachmentDto[]', () => {
    const dto = toChatMessageDto(makeMessage(), [makeRecord()]);
    expect(dto.attachments).toHaveLength(1);
    expect(dto.attachments[0]!.id).toBe('att-1');
    expect(dto.attachments[0]).not.toHaveProperty('sourceUrl');
  });
});

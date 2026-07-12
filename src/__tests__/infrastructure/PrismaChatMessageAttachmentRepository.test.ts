/**
 * messaging-inbox-v2-media — fix wave (adversarial review, Tanda 1 backend).
 * Unit tests for `PrismaChatMessageAttachmentRepository` with a mocked Prisma
 * singleton (pattern mirrors `PrismaChatMessageRepository.orderBy.test.ts` /
 * `PrismaTaskAttachmentRepository.test.ts`). Covers three findings that can ONLY
 * be pinned at the adapter level (the in-memory port doesn't reproduce Prisma's
 * upsert-is-not-atomic / update-field-omission semantics):
 *
 *   - fix-be #2 (MEDIUM) — markFailed must use `updateMany` guarded by
 *     `status != 'downloaded'`, never an unconditional `update`.
 *   - fix-be #4 (LOW-MEDIUM) — a P2002 on the upsert's internal INSERT (two
 *     concurrent deliveries for the same `chatwootAttachmentId`) must be caught
 *     and retried as an UPDATE, never propagate as a raw 500.
 *   - fix-be #8 (BAJO) — an explicit `null` in the update branch's optional
 *     fields must reach Prisma as `null` (clears the field), NOT collapsed to
 *     `undefined` (which Prisma treats as "leave untouched").
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    chatMessageAttachment: {
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaChatMessageAttachmentRepository } from '../../infrastructure/adapters/prisma/PrismaChatMessageAttachmentRepository';
import { ChatAttachmentNotFoundError } from '../../domain/errors/chatAttachment';
import type { UpsertChatMessageAttachmentInput } from '../../domain/ports/ChatMessageAttachmentRepository';

const mockPrisma = prisma as unknown as {
  chatMessageAttachment: {
    upsert: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findUnique: jest.Mock;
  };
};

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    messageId: 'msg-1',
    chatwootAttachmentId: 42,
    fileType: 'image',
    contentType: 'image/jpeg',
    filename: null,
    sizeBytes: null,
    width: null,
    height: null,
    storageKey: null,
    thumbStorageKey: null,
    sourceUrl: 'https://chat.ipnext.com.ar/x/1.jpg',
    thumbSourceUrl: null,
    status: 'pending',
    downloadAttempts: 0,
    lastError: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function baseInput(overrides: Partial<UpsertChatMessageAttachmentInput> = {}): UpsertChatMessageAttachmentInput {
  return {
    messageId: 'msg-1',
    chatwootAttachmentId: 42,
    fileType: 'image',
    contentType: 'image/jpeg',
    sourceUrl: 'https://chat.ipnext.com.ar/x/1.jpg',
    ...overrides,
  };
}

afterEach(() => jest.resetAllMocks());

describe('PrismaChatMessageAttachmentRepository', () => {
  describe('markFailed — guard atómico contra pisar un downloaded en carrera (fix-be #2, MEDIUM)', () => {
    it('usa updateMany con where {id, status: {not: "downloaded"}}, no un update incondicional', async () => {
      mockPrisma.chatMessageAttachment.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.chatMessageAttachment.findUnique.mockResolvedValue(
        baseRow({ status: 'failed', downloadAttempts: 1, lastError: 'timeout' }),
      );
      const repo = new PrismaChatMessageAttachmentRepository();

      const result = await repo.markFailed('att-1', { error: 'timeout' });

      expect(mockPrisma.chatMessageAttachment.updateMany).toHaveBeenCalledWith({
        where: { id: 'att-1', status: { not: 'downloaded' } },
        data: { status: 'failed', downloadAttempts: { increment: 1 }, lastError: 'timeout' },
      });
      expect(mockPrisma.chatMessageAttachment.update).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.downloadAttempts).toBe(1);
    });

    it('fila YA downloaded (carrera ganada por markDownloaded, updateMany matchea 0 filas) → devuelve la fila SIN pisarla', async () => {
      mockPrisma.chatMessageAttachment.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.chatMessageAttachment.findUnique.mockResolvedValue(
        baseRow({ status: 'downloaded', storageKey: 'messaging/conv-1/att-1.jpg', downloadAttempts: 0, lastError: null }),
      );
      const repo = new PrismaChatMessageAttachmentRepository();

      const result = await repo.markFailed('att-1', { error: 'timeout (stale attempt)' });

      expect(result.status).toBe('downloaded');
      expect(result.storageKey).toBe('messaging/conv-1/att-1.jpg');
      expect(result.downloadAttempts).toBe(0); // NOT incremented by the losing attempt
      expect(result.lastError).toBeNull(); // NOT overwritten by the loser's error
    });

    it('id inexistente (updateMany 0 filas Y findUnique null) → ChatAttachmentNotFoundError', async () => {
      mockPrisma.chatMessageAttachment.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.chatMessageAttachment.findUnique.mockResolvedValue(null);
      const repo = new PrismaChatMessageAttachmentRepository();

      await expect(repo.markFailed('ghost', { error: 'x' })).rejects.toBeInstanceOf(ChatAttachmentNotFoundError);
    });
  });

  describe('upsertByChatwootAttachmentId — P2002 en el upsert no-atómico (fix-be #4, LOW-MEDIUM)', () => {
    it('P2002 (la OTRA delivery concurrente ganó el INSERT) → reintenta como UPDATE, no propaga un 500', async () => {
      mockPrisma.chatMessageAttachment.upsert.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed on the fields: (`chatwootAttachmentId`)'), { code: 'P2002' }),
      );
      mockPrisma.chatMessageAttachment.update.mockResolvedValue(baseRow({ contentType: 'image/png' }));
      const repo = new PrismaChatMessageAttachmentRepository();

      const result = await repo.upsertByChatwootAttachmentId(baseInput({ contentType: 'image/png' }));

      expect(result.chatwootAttachmentId).toBe(42);
      expect(result.contentType).toBe('image/png');
      expect(mockPrisma.chatMessageAttachment.update).toHaveBeenCalledWith({
        where: { chatwootAttachmentId: 42 },
        data: expect.objectContaining({ messageId: 'msg-1', contentType: 'image/png' }),
      });
    });

    it('un error NO-P2002 en el upsert (ej. conexión caída) se propaga, no se traga', async () => {
      mockPrisma.chatMessageAttachment.upsert.mockRejectedValue(
        Object.assign(new Error('Server has closed the connection.'), { code: 'P1017' }),
      );
      const repo = new PrismaChatMessageAttachmentRepository();

      await expect(repo.upsertByChatwootAttachmentId(baseInput())).rejects.toThrow('Server has closed the connection.');
      expect(mockPrisma.chatMessageAttachment.update).not.toHaveBeenCalled();
    });
  });

  describe('upsertByChatwootAttachmentId — update branch: null explícito vs ausente (fix-be #8, BAJO)', () => {
    it('filename explícitamente null (Chatwoot corrigió: "ya no tiene nombre") se envía como null a Prisma (limpia el campo)', async () => {
      mockPrisma.chatMessageAttachment.upsert.mockResolvedValue(baseRow({ filename: null }));
      const repo = new PrismaChatMessageAttachmentRepository();

      await repo.upsertByChatwootAttachmentId(baseInput({ filename: null }));

      const call = mockPrisma.chatMessageAttachment.upsert.mock.calls[0][0];
      expect(call.update.filename).toBeNull();
    });

    it('filename AUSENTE del input (key no provista) se envía como undefined a Prisma (no lo toca)', async () => {
      mockPrisma.chatMessageAttachment.upsert.mockResolvedValue(baseRow());
      const repo = new PrismaChatMessageAttachmentRepository();

      await repo.upsertByChatwootAttachmentId(baseInput()); // no `filename` key at all

      const call = mockPrisma.chatMessageAttachment.upsert.mock.calls[0][0];
      expect(call.update.filename).toBeUndefined();
    });

    it('mismo criterio para sizeBytes/width/height/thumbSourceUrl: null explícito viaja como null, ausente como undefined', async () => {
      mockPrisma.chatMessageAttachment.upsert.mockResolvedValue(baseRow());
      const repo = new PrismaChatMessageAttachmentRepository();

      await repo.upsertByChatwootAttachmentId(
        baseInput({ sizeBytes: null, width: null, height: null, thumbSourceUrl: null }),
      );

      const call = mockPrisma.chatMessageAttachment.upsert.mock.calls[0][0];
      expect(call.update.sizeBytes).toBeNull();
      expect(call.update.width).toBeNull();
      expect(call.update.height).toBeNull();
      expect(call.update.thumbSourceUrl).toBeNull();
    });
  });
});

/**
 * external-bulk-messaging (1.6) — PrismaExternalBulkPreviewRepository. Mocked-Prisma
 * pattern (molde `PrismaClosedServiceOrderRepository.pendingWhere.test.ts`) — no DB
 * local. Pin del mecanismo EXACTO de `markConsumed` (D8: `updateMany({where:{id,
 * consumedAt:null}, data:{consumedAt, campaignId}})` → `count===1`) y del `limit`
 * acotado de `deleteExpiredBefore` (D9).
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    externalBulkPreview: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaExternalBulkPreviewRepository } from '../../infrastructure/adapters/prisma/PrismaExternalBulkPreviewRepository';

const mockPrisma = prisma as unknown as {
  externalBulkPreview: {
    create: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
    findMany: jest.Mock;
  };
};

const ROW = {
  id: 'preview-1',
  payloadHash: 'hash-1',
  templateRef: 'HXabc123',
  templateName: 'recordatorio_deuda',
  variables: { '1': 'Juan' },
  chatwootLabel: null,
  recipients: [{ phoneE164: '+5493364111111', phoneNormalized: '3364111111', name: 'Juan', variables: {} }],
  invalid: [],
  validCount: 1,
  invalidCount: 0,
  expiresAt: new Date('2026-09-02T00:15:00.000Z'),
  consumedAt: null,
  campaignId: null,
  createdAt: new Date('2026-09-02T00:00:00.000Z'),
};

describe('PrismaExternalBulkPreviewRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('create mapea el data completo y devuelve el entity con fechas ISO', async () => {
    mockPrisma.externalBulkPreview.create.mockResolvedValueOnce(ROW);
    const repo = new PrismaExternalBulkPreviewRepository();

    const created = await repo.create({
      payloadHash: 'hash-1',
      templateRef: 'HXabc123',
      templateName: 'recordatorio_deuda',
      variables: { '1': 'Juan' },
      chatwootLabel: null,
      recipients: [{ phoneE164: '+5493364111111', phoneNormalized: '3364111111', name: 'Juan', variables: {} }],
      invalid: [],
      validCount: 1,
      invalidCount: 0,
      expiresAt: '2026-09-02T00:15:00.000Z',
    });

    expect(mockPrisma.externalBulkPreview.create).toHaveBeenCalledTimes(1);
    expect(created.id).toBe('preview-1');
    expect(created.expiresAt).toBe('2026-09-02T00:15:00.000Z');
    expect(created.consumedAt).toBeNull();
    expect(created.campaignId).toBeNull();
  });

  it('findById devuelve null cuando findUnique no encuentra la fila', async () => {
    mockPrisma.externalBulkPreview.findUnique.mockResolvedValueOnce(null);
    const repo = new PrismaExternalBulkPreviewRepository();

    const found = await repo.findById('does-not-exist');

    expect(found).toBeNull();
  });

  it('findById mapea la fila cruda a entity', async () => {
    mockPrisma.externalBulkPreview.findUnique.mockResolvedValueOnce(ROW);
    const repo = new PrismaExternalBulkPreviewRepository();

    const found = await repo.findById('preview-1');

    expect(found?.payloadHash).toBe('hash-1');
    expect(found?.recipients).toEqual([
      { phoneE164: '+5493364111111', phoneNormalized: '3364111111', name: 'Juan', variables: {} },
    ]);
  });

  it('markConsumed: updateMany WHERE id+consumedAt:null, count===1 → true (D8 mecanismo exacto)', async () => {
    mockPrisma.externalBulkPreview.updateMany.mockResolvedValueOnce({ count: 1 });
    const repo = new PrismaExternalBulkPreviewRepository();

    const won = await repo.markConsumed('preview-1', 'campaign-1');

    expect(won).toBe(true);
    expect(mockPrisma.externalBulkPreview.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.externalBulkPreview.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'preview-1', consumedAt: null });
    expect(call.data.campaignId).toBe('campaign-1');
    expect(call.data.consumedAt).toEqual(expect.any(Date));
  });

  it('markConsumed: count===0 (otro ya lo consumió) → false', async () => {
    mockPrisma.externalBulkPreview.updateMany.mockResolvedValueOnce({ count: 0 });
    const repo = new PrismaExternalBulkPreviewRepository();

    const won = await repo.markConsumed('preview-1', 'campaign-2');

    expect(won).toBe(false);
  });

  it('deleteExpiredBefore borra WHERE expiresAt < before, acotado por limit (D9)', async () => {
    mockPrisma.externalBulkPreview.findMany.mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }]);
    mockPrisma.externalBulkPreview.deleteMany.mockResolvedValueOnce({ count: 2 });
    const repo = new PrismaExternalBulkPreviewRepository();
    const before = new Date('2026-06-01T00:00:00.000Z');

    const deletedCount = await repo.deleteExpiredBefore(before, 500);

    expect(deletedCount).toBe(2);
    const findCall = mockPrisma.externalBulkPreview.findMany.mock.calls[0][0];
    expect(findCall.where).toEqual({ expiresAt: { lt: before } });
    expect(findCall.take).toBe(500);
    const deleteCall = mockPrisma.externalBulkPreview.deleteMany.mock.calls[0][0];
    expect(deleteCall.where).toEqual({ id: { in: ['p1', 'p2'] } });
  });
});

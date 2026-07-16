/**
 * inbox-template-send (PORT-2, T7) — adapter intention test with a mocked Prisma
 * client (molde `PrismaConversationRepository.orderBy.test.ts` /
 * `PrismaContractPairingReader.where.test.ts`). Pins the EXACT `data` shape sent
 * to `prisma.conversation.update`: SOLO `lastMessageAt`/`lastMessagePreview` —
 * jamás `canReply`/`status`/`assigneeId`/`areaId` (design D2, misma disciplina
 * que `InMemoryConversationRepository.bumpLastMessage`, que ambos adapters NO
 * pueden divergir).
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    conversation: {
      update: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaConversationRepository } from '../../infrastructure/adapters/prisma/PrismaConversationRepository';

const mockPrisma = prisma as unknown as {
  conversation: { update: jest.Mock };
};

describe('PrismaConversationRepository — bumpLastMessage (PORT-2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('update: SOLO data.lastMessageAt/data.lastMessagePreview, where por id, jamás canReply/status/assigneeId/areaId', async () => {
    mockPrisma.conversation.update.mockResolvedValue({
      id: 'conv-1',
      chatwootConversationId: 5,
      origin: 'chatwoot',
      contactName: null,
      contactPhone: '+5491123456789',
      contactPhoneE164: '+5491123456789',
      status: 'open',
      canReply: false,
      lastMessageAt: new Date('2026-07-16T10:00:00.000Z'),
      lastMessagePreview: 'Hola Juan, debés $5.000',
      assigneeId: null,
      areaId: null,
      assignee: null,
      area: null,
      campaignRecipients: [],
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-16T10:00:00.000Z'),
    });

    const repo = new PrismaConversationRepository();
    const result = await repo.bumpLastMessage('conv-1', {
      lastMessageAt: '2026-07-16T10:00:00.000Z',
      lastMessagePreview: 'Hola Juan, debés $5.000',
    });

    const call = mockPrisma.conversation.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'conv-1' });
    expect(Object.keys(call.data).sort()).toEqual(['lastMessageAt', 'lastMessagePreview']);
    expect(call.data.lastMessagePreview).toBe('Hola Juan, debés $5.000');
    expect(result!.lastMessagePreview).toBe('Hola Juan, debés $5.000');
    expect(result!.canReply).toBe(false);
  });

  it('P2025 (record not found) → null (misma convención que updateLocalFields)', async () => {
    mockPrisma.conversation.update.mockRejectedValue({ code: 'P2025' });

    const repo = new PrismaConversationRepository();
    const result = await repo.bumpLastMessage('ghost', {
      lastMessageAt: '2026-07-16T10:00:00.000Z',
      lastMessagePreview: 'x',
    });

    expect(result).toBeNull();
  });
});

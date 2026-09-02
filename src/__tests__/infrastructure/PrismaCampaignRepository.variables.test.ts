/**
 * external-bulk-messaging (D4.c, scope addition B1) — pin that
 * `PrismaCampaignRepository.bulkCreateRecipients` persists the per-recipient
 * `variables` snapshot (nullable JSONB, additive) and that `toCampaignRecipient`
 * maps it back. Mocked-Prisma pattern (molde
 * `PrismaClosedServiceOrderRepository.pendingWhere.test.ts`) — no DB local.
 */

jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    campaignRecipient: {
      findMany: jest.fn(),
      createMany: jest.fn(),
    },
  },
}));

import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { PrismaCampaignRepository, toCampaignRecipient } from '../../infrastructure/adapters/prisma/PrismaCampaignRepository';

const mockPrisma = prisma as unknown as {
  campaignRecipient: { findMany: jest.Mock; createMany: jest.Mock };
};

describe('PrismaCampaignRepository — CampaignRecipient.variables (D4.c)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('bulkCreateRecipients pasa variables (o Prisma.JsonNull si ausente) al createMany', async () => {
    mockPrisma.campaignRecipient.findMany.mockResolvedValueOnce([]); // existing lookup
    mockPrisma.campaignRecipient.createMany.mockResolvedValueOnce({ count: 2 });
    mockPrisma.campaignRecipient.findMany.mockResolvedValueOnce([]); // re-fetch (irrelevant for this assertion)

    const repo = new PrismaCampaignRepository();
    await repo.bulkCreateRecipients('camp-1', [
      { clientId: 'c1', phoneNormalized: '111', phoneE164: '+5491111', variables: { nombre: 'Ana' } },
      { clientId: 'c2', phoneNormalized: '222', phoneE164: '+5492222' },
    ]);

    expect(mockPrisma.campaignRecipient.createMany).toHaveBeenCalledTimes(1);
    const rows = mockPrisma.campaignRecipient.createMany.mock.calls[0][0].data;
    const withVars = rows.find((r: any) => r.clientId === 'c1');
    const withoutVars = rows.find((r: any) => r.clientId === 'c2');
    expect(withVars.variables).toEqual({ nombre: 'Ana' });
    // ausente → Prisma.JsonNull (SQL NULL explícito), NUNCA `undefined` (createMany no tolera omitir la key)
    expect(withoutVars.variables).toBe(Prisma.JsonNull);
  });

  it('toCampaignRecipient mapea variables de la fila cruda; null cuando la columna es null', () => {
    const withVars = toCampaignRecipient({
      id: 'r1',
      campaignId: 'camp-1',
      clientId: 'c1',
      contactName: null,
      phoneNormalized: '111',
      phoneE164: '+5491111',
      variables: { nombre: 'Ana' },
      status: 'queued',
      providerId: null,
      chatwootConversationId: null,
      conversationId: null,
      error: null,
      taskId: null,
      taskFromStageId: null,
      taskResultingStageId: null,
      sentAt: null,
      deliveredAt: null,
      createdAt: new Date('2026-07-13T00:00:00.000Z'),
    });
    const withoutVars = toCampaignRecipient({
      id: 'r2',
      campaignId: 'camp-1',
      clientId: 'c2',
      contactName: null,
      phoneNormalized: '222',
      phoneE164: '+5492222',
      variables: null,
      status: 'queued',
      providerId: null,
      chatwootConversationId: null,
      conversationId: null,
      error: null,
      taskId: null,
      taskFromStageId: null,
      taskResultingStageId: null,
      sentAt: null,
      deliveredAt: null,
      createdAt: new Date('2026-07-13T00:00:00.000Z'),
    });

    expect(withVars.variables).toEqual({ nombre: 'Ana' });
    expect(withoutVars.variables).toBeNull();
  });
});

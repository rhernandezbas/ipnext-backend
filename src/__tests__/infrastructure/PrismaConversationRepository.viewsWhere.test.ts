/**
 * inbox-views (Ola 1, VIEW-1/COUNT-2) — adapter intention test con Prisma mockeado
 * (molde `PrismaConversationRepository.orderBy.test.ts`). Pinea:
 *  1. el `where` del bucket "Sin atender" (`unattended:true` → NO-resuelta +
 *     `lastPublicMessageDirection:'inbound'`), con precedencia sobre `status`;
 *  2. que `count(query)` manda EXACTAMENTE el mismo `where` que `list` (una sola
 *     fuente de verdad — `buildConversationWhere` compartido). El lado in-memory
 *     ya está cubierto por `ListConversations.unattendedFilter.test.ts` /
 *     `GetInboxViewCounts.test.ts`; los dos adapters NO pueden divergir.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    conversation: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaConversationRepository } from '../../infrastructure/adapters/prisma/PrismaConversationRepository';

const mockPrisma = prisma as unknown as {
  conversation: { findMany: jest.Mock; count: jest.Mock };
};

// conversation-snooze (Ola 6c) — Abiertas/Sin atender excluyen las POSPUESTAS VIGENTES vía un OR
// NULL-safe. `now` es dinámico (`new Date()` en el builder) → `expect.any(Date)` en el `lte`.
const notVigenteSnoozed = [
  { status: { not: 'snoozed' } },
  { snoozedUntil: null },
  { snoozedUntil: { lte: expect.any(Date) } },
];

describe('PrismaConversationRepository — where del bucket Sin atender (VIEW-1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.conversation.findMany.mockResolvedValue([]);
    mockPrisma.conversation.count.mockResolvedValue(0);
  });

  it("unattended:true → where = { status: {not:'resolved'}, lastPublicMessageDirection: 'inbound' } (MISMO en findMany y count)", async () => {
    const repo = new PrismaConversationRepository();
    await repo.list({ unattended: true, page: 1, limit: 25 });

    const expected = { status: { not: 'resolved' }, lastPublicMessageDirection: 'inbound', OR: notVigenteSnoozed };
    expect(mockPrisma.conversation.findMany.mock.calls[0][0].where).toEqual(expected);
    expect(mockPrisma.conversation.count.mock.calls[0][0].where).toEqual(expected);
  });

  it('unattended:true GANA sobre status (lleva su propio filtro de ciclo de vida — precedencia del port)', async () => {
    const repo = new PrismaConversationRepository();
    await repo.list({ unattended: true, status: 'resolved', page: 1, limit: 25 });

    expect(mockPrisma.conversation.findMany.mock.calls[0][0].where).toEqual({
      status: { not: 'resolved' },
      lastPublicMessageDirection: 'inbound',
      OR: notVigenteSnoozed,
    });
  });

  it('combinable con assigneeId (Mías + Sin atender) — AND de ambas claves', async () => {
    const repo = new PrismaConversationRepository();
    await repo.list({ unattended: true, assigneeId: 'user-1', page: 1, limit: 25 });

    expect(mockPrisma.conversation.findMany.mock.calls[0][0].where).toEqual({
      assigneeId: 'user-1',
      status: { not: 'resolved' },
      lastPublicMessageDirection: 'inbound',
      OR: notVigenteSnoozed,
    });
  });

  it('unattended ausente → where NO agrega lastPublicMessageDirection (no-regresión del listado)', async () => {
    const repo = new PrismaConversationRepository();
    await repo.list({ status: 'open', page: 1, limit: 25 });

    expect(mockPrisma.conversation.findMany.mock.calls[0][0].where).not.toHaveProperty('lastPublicMessageDirection');
  });

  it("conversation-snooze (Ola 6c): snoozed:true → where = { status:'snoozed', snoozedUntil:{gt: now} } (SOLO vigentes)", async () => {
    const repo = new PrismaConversationRepository();
    await repo.list({ snoozed: true, page: 1, limit: 25 });

    expect(mockPrisma.conversation.findMany.mock.calls[0][0].where).toEqual({
      status: 'snoozed',
      snoozedUntil: { gt: expect.any(Date) },
    });
  });

  it('conversation-snooze (Ola 6c): snoozed:true GANA sobre status/unattended (bucket propio)', async () => {
    const repo = new PrismaConversationRepository();
    await repo.list({ snoozed: true, status: 'open', unattended: true, page: 1, limit: 25 });

    expect(mockPrisma.conversation.findMany.mock.calls[0][0].where).toEqual({
      status: 'snoozed',
      snoozedUntil: { gt: expect.any(Date) },
    });
  });
});

describe('PrismaConversationRepository — count(query) comparte el builder del where (COUNT-2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.conversation.count.mockResolvedValue(7);
  });

  it("count({status:'open', unassigned:true}) → prisma.conversation.count con el MISMO where que list (assigneeId null)", async () => {
    const repo = new PrismaConversationRepository();
    const result = await repo.count({ status: 'open', unassigned: true });

    expect(result).toBe(7);
    expect(mockPrisma.conversation.count.mock.calls[0][0].where).toEqual({
      assigneeId: null,
      status: { not: 'resolved' },
      OR: notVigenteSnoozed,
    });
    // Contar JAMÁS trae filas (anti-N+1): findMany no se llama.
    expect(mockPrisma.conversation.findMany).not.toHaveBeenCalled();
  });

  it('count({unattended:true}) → mismo where del bucket Sin atender que el listado', async () => {
    const repo = new PrismaConversationRepository();
    await repo.count({ unattended: true });

    expect(mockPrisma.conversation.count.mock.calls[0][0].where).toEqual({
      status: { not: 'resolved' },
      lastPublicMessageDirection: 'inbound',
      OR: notVigenteSnoozed,
    });
  });
});

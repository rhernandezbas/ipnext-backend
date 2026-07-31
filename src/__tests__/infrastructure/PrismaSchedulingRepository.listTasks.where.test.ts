/**
 * PrismaSchedulingRepository.listTasks — adapter intention test (mocked
 * Prisma client), mismo molde que `PrismaTicketRepository.where.test.ts`.
 *
 * portal-ticket-messaging (v2.B) fix wave FINAL, G1 (HERMANO encontrado):
 * `ListPortalTasks` (portal) llama a `scheduling.listTasks({ customerId:
 * clientId })` y, igual que `ListPortalTickets`, confía 100% en que ese
 * `customerId` llegue al WHERE real — no hay re-chequeo de ownership por
 * tarea en el use case. Ninguna suite existente (`ListTasksFilter.test.ts`,
 * etc.) ejercita este adapter — todas corren contra
 * `InMemorySchedulingRepository`. Mismo revert-probe que G1: borrar
 * `if (filter?.customerId) where['customerId'] = ...` debe poner esto rojo.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    scheduledTask: {
      findMany: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaSchedulingRepository } from '../../infrastructure/adapters/prisma/PrismaSchedulingRepository';

const mockPrisma = prisma as unknown as {
  scheduledTask: { findMany: jest.Mock };
};

describe('PrismaSchedulingRepository — listTasks (G1 hermano: ownership del portal)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.scheduledTask.findMany.mockResolvedValue([]);
  });

  it('WHERE incluye customerId EN LA QUERY REAL — revert-probe: borrar esa línea del adapter pone este test en rojo', async () => {
    const repo = new PrismaSchedulingRepository();
    await repo.listTasks({ customerId: 'client-1' });

    const call = mockPrisma.scheduledTask.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ customerId: 'client-1', archivedAt: null });
  });

  it('sin customerId (uso admin), el WHERE NO lo incluye', async () => {
    const repo = new PrismaSchedulingRepository();
    await repo.listTasks({});

    const call = mockPrisma.scheduledTask.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('customerId');
  });
});

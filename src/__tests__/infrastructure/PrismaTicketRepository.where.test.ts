/**
 * PrismaTicketRepository — adapter intention tests with mocked Prisma client
 * (mismo molde que `PrismaTicketCommentRepository.where.test.ts`).
 *
 * portal-ticket-messaging (v2.B) fix wave FINAL, G1 (HIGH): el fix anterior
 * (F1) le dio red al WHERE de visibilidad de `PrismaTicketCommentRepository`,
 * pero dejó al HERMANO estructural sin cubrir — `PrismaTicketRepository.list`
 * es el OTRO invariante de ownership del portal: `ListPortalTickets` (y
 * `GetPortalTicket`/`GetPortalTicketMessageAttachmentFile` vía
 * `getBySequenceNumber`) confían 100% en que `customerId` llegue al WHERE
 * real — el use case NO re-chequea ownership por ticket en la lista. El
 * único test existente del adapter (`PrismaTicketRepository.toTicket.test.ts`)
 * cubre solo el mapper, nunca el WHERE — las 5 suites de portal SIEMPRE
 * ejercitan `InMemoryTicketRepository`.
 *
 * `list` con `customerId` es el REVERT-PROBE obligatorio: si alguien borra
 * `if (query.customerId) where['customerId'] = ...` (o lo mueve a un filtro
 * post-query), el `toEqual` de abajo deja de matchear y este test se pone
 * rojo. Confirmado a mano contra el adapter mutado (ver reporte de la fix
 * wave).
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    ticket: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaTicketRepository } from '../../infrastructure/adapters/prisma/PrismaTicketRepository';

const mockPrisma = prisma as unknown as {
  ticket: { findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock };
  $transaction: jest.Mock;
};

describe('PrismaTicketRepository — list (G1: INVARIANTE CENTRAL de ownership del portal)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.ticket.findMany.mockResolvedValue([]);
    mockPrisma.ticket.count.mockResolvedValue(0);
  });

  it('WHERE incluye customerId EN LA QUERY REAL cuando la query lo trae — revert-probe: borrar esa línea del adapter pone este test en rojo', async () => {
    const repo = new PrismaTicketRepository();
    await repo.list({ customerId: 'client-1', page: 1, limit: 25 });

    const call = mockPrisma.ticket.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ customerId: 'client-1', archivedAt: null });

    const countCall = mockPrisma.ticket.count.mock.calls[0][0];
    expect(countCall.where).toEqual({ customerId: 'client-1', archivedAt: null });
  });

  it('sin customerId (uso admin), el WHERE NO lo incluye — el filtro es condicional, no hardcodeado', async () => {
    const repo = new PrismaTicketRepository();
    await repo.list({ page: 1, limit: 25 });

    const call = mockPrisma.ticket.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ archivedAt: null });
    expect(call.where).not.toHaveProperty('customerId');
  });

  it('customerId se combina con el resto de los filtros (AND implícito del objeto WHERE)', async () => {
    const repo = new PrismaTicketRepository();
    await repo.list({ customerId: 'client-1', priority: 'high', page: 1, limit: 25 });

    const call = mockPrisma.ticket.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ customerId: 'client-1', priority: 'high', archivedAt: null });
  });
});

describe('PrismaTicketRepository — getBySequenceNumber (usado por GetPortalTicket / GetPortalTicketMessageAttachmentFile)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('busca por sequenceNumber SIN filtrar por cliente — el ownership lo re-chequea el caller comparando ticket.customerId', async () => {
    mockPrisma.ticket.findUnique.mockResolvedValue(null);
    const repo = new PrismaTicketRepository();

    await repo.getBySequenceNumber(42);

    const call = mockPrisma.ticket.findUnique.mock.calls[0][0];
    expect(call.where).toEqual({ sequenceNumber: 42 });
  });
});

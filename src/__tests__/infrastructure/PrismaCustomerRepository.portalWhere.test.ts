/**
 * PrismaCustomerRepository — WHEREs de scoping consumidos por el portal
 * (mocked Prisma client), mismo molde que `PrismaTicketRepository.where.test.ts`.
 *
 * portal-ticket-messaging (v2.B) fix wave FINAL, G1 (HERMANOS encontrados):
 * `ListPortalInvoices`, `ListPortalPlans`/`CreatePortalTicket`/`GetPortalTicket`
 * (vía `listContracts`) y `GetPortalMe` (vía `getPortalBalanceSummary`) pasan
 * `clientId` del token directo a estos tres métodos y confían 100% en que el
 * WHERE real lo aplique — ninguna suite existente ejercita este adapter con un
 * client mockeado (las suites de portal corren contra
 * `InMemoryCustomerRepository`; `PrismaCustomerRepository.mappers.test.ts` /
 * `.stats.test.ts` / `.list.segment.test.ts` no tocan estos tres métodos).
 * Mismo revert-probe que G1: borrar `clientId` del `where` debe poner esto rojo.
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    contract: {
      findMany: jest.fn(),
    },
    invoice: {
      findMany: jest.fn(),
      groupBy: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaCustomerRepository } from '../../infrastructure/adapters/prisma/PrismaCustomerRepository';

const mockPrisma = prisma as unknown as {
  contract: { findMany: jest.Mock };
  invoice: { findMany: jest.Mock; groupBy: jest.Mock; findFirst: jest.Mock };
};

describe('PrismaCustomerRepository — listContracts (G1 hermano: ListPortalPlans/CreatePortalTicket/GetPortalTicket)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.contract.findMany.mockResolvedValue([]);
  });

  it('WHERE incluye clientId EN LA QUERY REAL — revert-probe: borrar esa línea del adapter pone este test en rojo', async () => {
    const repo = new PrismaCustomerRepository();
    await repo.listContracts('client-1');

    const call = mockPrisma.contract.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ clientId: 'client-1' });
  });
});

describe('PrismaCustomerRepository — listInvoices (G1 hermano: ListPortalInvoices)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.invoice.findMany.mockResolvedValue([]);
  });

  it('WHERE incluye clientId EN LA QUERY REAL — revert-probe: borrar esa línea del adapter pone este test en rojo', async () => {
    const repo = new PrismaCustomerRepository();
    await repo.listInvoices('client-1');

    const call = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ clientId: 'client-1' });
  });
});

describe('PrismaCustomerRepository — getPortalBalanceSummary (G1 hermano: GetPortalMe)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.invoice.groupBy.mockResolvedValue([]);
    mockPrisma.invoice.findFirst.mockResolvedValue(null);
  });

  it('groupBy y findFirst filtran por clientId EN LA QUERY REAL', async () => {
    const repo = new PrismaCustomerRepository();
    await repo.getPortalBalanceSummary('client-1');

    const groupByCall = mockPrisma.invoice.groupBy.mock.calls[0][0];
    expect(groupByCall.where).toMatchObject({ clientId: 'client-1' });

    const findFirstCall = mockPrisma.invoice.findFirst.mock.calls[0][0];
    expect(findFirstCall.where).toEqual({ clientId: 'client-1' });
  });
});

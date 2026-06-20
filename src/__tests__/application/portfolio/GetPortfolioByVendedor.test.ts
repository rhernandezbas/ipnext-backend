/**
 * Use-case tests for GetPortfolioByVendedor (admin view — Fase 3 super admin).
 *
 * Same PortfolioDto shape as /mine, but for the vendedor passed directly (admin
 * picks any agent). `unmapped` is always false (a vendedor is always provided).
 *
 * Uses in-memory adapters only (no Prisma, no mocks).
 * Strict TDD: written BEFORE the implementation exists.
 */
import { GetPortfolioByVendedor } from '@application/use-cases/portfolio/GetPortfolioByVendedor';
import { InMemoryPortfolioReadRepository } from '../../../infrastructure/adapters/in-memory/InMemoryPortfolioReadRepository';
import { InMemoryTicketRepository } from '../../../infrastructure/adapters/in-memory/InMemoryTicketRepository';

const ZERO_BUCKETS = { '0-3': 0, '3-6': 0, '6-12': 0, '12+': 0 };

describe('GetPortfolioByVendedor — vendedor with clients', () => {
  it('returns items + summary for the vendedor (buckets, debt, claims)', async () => {
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();

    // VENDEDOR_A: two clients, one with two contracts (dedup → contractsCount 2).
    portfolio.seed({ clientId: 'c1', clientName: 'Alice', status: 'active', balanceDue: 1500.5, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_A', startDate: '2025-03-01T00:00:00.000Z' });
    portfolio.seed({ clientId: 'c1', clientName: 'Alice', status: 'active', balanceDue: 1500.5, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_A', startDate: '2024-11-01T00:00:00.000Z' });
    portfolio.seed({ clientId: 'c2', clientName: 'Bob', status: 'late', balanceDue: null, balanceCurrency: null, vendedor: 'VENDEDOR_A', startDate: '2026-05-01T00:00:00.000Z' });
    // A different vendedor MUST NOT leak in.
    portfolio.seed({ clientId: 'cX', clientName: 'Other', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_B', startDate: '2025-03-01T00:00:00.000Z' });

    // cA claims: c1 has 1 open ticket.
    await tickets.create({ subject: 's', description: 'd', customerId: 'c1' });

    const uc = new GetPortfolioByVendedor(portfolio, tickets);
    const res = await uc.execute('VENDEDOR_A', new Date('2026-06-15T00:00:00.000Z'));

    expect(res.unmapped).toBe(false);
    expect(res.items).toHaveLength(2);
    expect(res.summary.total).toBe(2);
    expect(res.summary.withDebt).toBe(2); // c1 balance>0, c2 late
    expect(res.summary.withClaims).toBe(1); // c1 has an open ticket

    const alice = res.items.find((i) => i.clientId === 'c1')!;
    expect(alice.contractsCount).toBe(2);
    expect(alice.oldestStartDate).toBe('2024-11-01T00:00:00.000Z'); // MIN
    expect(alice.hasDebt).toBe(true);
    expect(alice.debtAmount).toBe(1500.5);
    expect(alice.openClaims).toBe(1);
    expect(alice.ageBucket).toBe('12+'); // ~19 mo

    const bob = res.items.find((i) => i.clientId === 'c2')!;
    expect(bob.hasDebt).toBe(true); // late
    expect(bob.ageBucket).toBe('0-3');
  });
});

describe('GetPortfolioByVendedor — vendedor without clients', () => {
  it('returns empty items + zeroed summary (not unmapped)', async () => {
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    // Some other vendedor has clients, but the queried one has none.
    portfolio.seed({ clientId: 'cX', clientName: 'Other', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'OTHER', startDate: '2025-03-01T00:00:00.000Z' });

    const uc = new GetPortfolioByVendedor(portfolio, tickets);
    const res = await uc.execute('GHOST', new Date('2026-06-15T00:00:00.000Z'));

    expect(res).toEqual({
      unmapped: false,
      items: [],
      summary: { total: 0, byBucket: ZERO_BUCKETS, active: 0, withDebt: 0, withClaims: 0 },
    });
  });
});

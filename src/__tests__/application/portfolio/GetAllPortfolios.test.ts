/**
 * Use-case tests for GetAllPortfolios (admin view — ALL agents — Fase 3).
 *
 * Returns every client that has >=1 contract with a non-null vendedor, each item
 * carrying its `vendedor`, plus a GLOBAL summary. A single client with contracts
 * under two vendedores yields TWO items (one per vendedor).
 *
 * Uses in-memory adapters only (no Prisma, no mocks).
 * Strict TDD: written BEFORE the implementation exists.
 */
import { GetAllPortfolios } from '@application/use-cases/portfolio/GetAllPortfolios';
import { InMemoryPortfolioReadRepository } from '../../../infrastructure/adapters/in-memory/InMemoryPortfolioReadRepository';
import { InMemoryTicketRepository } from '../../../infrastructure/adapters/in-memory/InMemoryTicketRepository';

describe('GetAllPortfolios — multiple vendedores', () => {
  it('returns one item per (client, vendedor), each tagged with its vendedor', async () => {
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();

    // VENDEDOR_A → Alice (active, debt) + Bob (late)
    portfolio.seed({ clientId: 'c1', clientName: 'Alice', status: 'active', balanceDue: 200, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_A', startDate: '2025-03-01T00:00:00.000Z' });
    portfolio.seed({ clientId: 'c2', clientName: 'Bob', status: 'late', balanceDue: null, balanceCurrency: null, vendedor: 'VENDEDOR_A', startDate: '2026-05-01T00:00:00.000Z' });
    // VENDEDOR_B → Carol (active, clean)
    portfolio.seed({ clientId: 'c3', clientName: 'Carol', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_B', startDate: '2026-04-01T00:00:00.000Z' });

    // c1 has 1 open claim
    await tickets.create({ subject: 's', description: 'd', customerId: 'c1' });

    const uc = new GetAllPortfolios(portfolio, tickets);
    const res = await uc.execute(new Date('2026-06-15T00:00:00.000Z'));

    expect(res.items).toHaveLength(3);

    const alice = res.items.find((i) => i.clientId === 'c1')!;
    expect(alice.vendedor).toBe('VENDEDOR_A');
    expect(alice.hasDebt).toBe(true);
    expect(alice.openClaims).toBe(1);

    const carol = res.items.find((i) => i.clientId === 'c3')!;
    expect(carol.vendedor).toBe('VENDEDOR_B');
    expect(carol.hasDebt).toBe(false);

    // Global summary sums across ALL vendedores.
    expect(res.summary.total).toBe(3);
    expect(res.summary.active).toBe(2); // Alice + Carol
    expect(res.summary.withDebt).toBe(2); // Alice (balance) + Bob (late)
    expect(res.summary.withClaims).toBe(1); // Alice
  });
});

describe('GetAllPortfolios — same client under two vendedores', () => {
  it('emits one item per (client, vendedor) — TWO items for the shared client', async () => {
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();

    // Client c1 has contracts under BOTH VENDEDOR_A and VENDEDOR_B.
    portfolio.seed({ clientId: 'c1', clientName: 'Shared', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_A', startDate: '2025-01-01T00:00:00.000Z' });
    portfolio.seed({ clientId: 'c1', clientName: 'Shared', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_A', startDate: '2025-06-01T00:00:00.000Z' });
    portfolio.seed({ clientId: 'c1', clientName: 'Shared', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_B', startDate: '2024-01-01T00:00:00.000Z' });

    // c1 has 2 open claims — counted PER item (both items see the client's open count).
    await tickets.create({ subject: 's', description: 'd', customerId: 'c1' });
    await tickets.create({ subject: 's', description: 'd', customerId: 'c1' });

    const uc = new GetAllPortfolios(portfolio, tickets);
    const res = await uc.execute(new Date('2026-06-15T00:00:00.000Z'));

    expect(res.items).toHaveLength(2);

    const a = res.items.find((i) => i.vendedor === 'VENDEDOR_A')!;
    const b = res.items.find((i) => i.vendedor === 'VENDEDOR_B')!;
    expect(a.clientId).toBe('c1');
    expect(b.clientId).toBe('c1');
    // Per (client, vendedor) grouping: A has 2 contracts (MIN 2025-01-01); B has 1 (2024-01-01).
    expect(a.contractsCount).toBe(2);
    expect(a.oldestStartDate).toBe('2025-01-01T00:00:00.000Z');
    expect(b.contractsCount).toBe(1);
    expect(b.oldestStartDate).toBe('2024-01-01T00:00:00.000Z');
    // Each item reflects the client's open-claims count.
    expect(a.openClaims).toBe(2);
    expect(b.openClaims).toBe(2);

    // Global summary: 2 items, both count toward totals.
    expect(res.summary.total).toBe(2);
    expect(res.summary.withClaims).toBe(2);
  });
});

describe('GetAllPortfolios — empty', () => {
  it('returns empty items + zeroed summary when no contracts have a vendedor', async () => {
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();

    const uc = new GetAllPortfolios(portfolio, tickets);
    const res = await uc.execute(new Date('2026-06-15T00:00:00.000Z'));

    expect(res.items).toEqual([]);
    expect(res.summary).toEqual({
      total: 0,
      byBucket: { '0-3': 0, '3-6': 0, '6-12': 0, '12+': 0 },
      active: 0,
      withDebt: 0,
      withClaims: 0,
    });
  });
});

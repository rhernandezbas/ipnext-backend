/**
 * Use-case tests for GetMyPortfolio (Mis clientes — Fase 3).
 *
 * Uses in-memory adapters only (no Prisma, no mocks):
 *  - InMemoryRbacUserRepository  → resolves grVendedorName from userId
 *  - InMemoryPortfolioReadRepository → clients (deduped) by vendedor
 *  - InMemoryTicketRepository    → open-claims aggregate per client
 *
 * Strict TDD: this file is written BEFORE the implementation exists.
 */
import { GetMyPortfolio } from '@application/use-cases/portfolio/GetMyPortfolio';
import { InMemoryRbacUserRepository } from '../../../infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryPortfolioReadRepository } from '../../../infrastructure/adapters/in-memory/InMemoryPortfolioReadRepository';
import { InMemoryTicketRepository } from '../../../infrastructure/adapters/in-memory/InMemoryTicketRepository';

/** Create a user mapped to a vendedor and return its id. */
async function makeUser(
  rbac: InMemoryRbacUserRepository,
  opts: { vendedor?: string | null; login?: string } = {},
): Promise<string> {
  const login = opts.login ?? `u-${Math.random().toString(36).slice(2)}`;
  const user = await rbac.create({
    name: login,
    email: `${login}@test.com`,
    login,
    passwordHash: 'x',
  });
  if (opts.vendedor !== undefined) {
    await rbac.update(user.id, { grVendedorName: opts.vendedor });
  }
  return user.id;
}

const ZERO_BUCKETS = { '0-3': 0, '3-6': 0, '6-12': 0, '12+': 0 };

describe('GetMyPortfolio — unmapped agent', () => {
  it('returns unmapped shape when grVendedorName is null', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    const userId = await makeUser(rbac, { vendedor: null });

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute(userId);

    expect(res).toEqual({
      unmapped: true,
      items: [],
      summary: { total: 0, byBucket: ZERO_BUCKETS, active: 0, withDebt: 0, withClaims: 0 },
    });
  });

  it('returns unmapped shape when grVendedorName is empty / whitespace', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    const userId = await makeUser(rbac, { vendedor: '   ' });

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute(userId);

    expect(res.unmapped).toBe(true);
    expect(res.items).toEqual([]);
    expect(res.summary.total).toBe(0);
  });

  it('returns unmapped shape when the user does not exist', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute('does-not-exist');

    expect(res.unmapped).toBe(true);
    expect(res.items).toEqual([]);
    expect(res.summary).toEqual({ total: 0, byBucket: ZERO_BUCKETS, active: 0, withDebt: 0, withClaims: 0 });
  });
});

describe('GetMyPortfolio — mapped happy path + dedup', () => {
  it('dedups by client (one client, two contracts same vendedor → one item, contractsCount 2, oldestStartDate = earlier)', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    const userId = await makeUser(rbac, { vendedor: 'VENDEDOR_A' });

    // Client c1 has TWO contracts with VENDEDOR_A.
    portfolio.seed({ clientId: 'c1', clientName: 'Alice', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_A', startDate: '2025-03-01T00:00:00.000Z' });
    portfolio.seed({ clientId: 'c1', clientName: 'Alice', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_A', startDate: '2024-11-01T00:00:00.000Z' });
    // Client c2 has ONE contract with VENDEDOR_A.
    portfolio.seed({ clientId: 'c2', clientName: 'Bob', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_A', startDate: '2025-01-15T00:00:00.000Z' });

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute(userId, new Date('2026-06-15T00:00:00.000Z'));

    expect(res.unmapped).toBe(false);
    expect(res.items).toHaveLength(2);
    expect(res.summary.total).toBe(2);

    const alice = res.items.find((i) => i.clientId === 'c1')!;
    expect(alice.clientName).toBe('Alice');
    expect(alice.contractsCount).toBe(2);
    expect(alice.oldestStartDate).toBe('2024-11-01T00:00:00.000Z'); // earlier of the two
  });

  it('does NOT include clients of a different vendedor', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    const userId = await makeUser(rbac, { vendedor: 'VENDEDOR_A' });

    portfolio.seed({ clientId: 'c1', clientName: 'Alice', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_A', startDate: '2025-03-01T00:00:00.000Z' });
    portfolio.seed({ clientId: 'c9', clientName: 'Other', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'VENDEDOR_B', startDate: '2025-03-01T00:00:00.000Z' });

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute(userId, new Date('2026-06-15T00:00:00.000Z'));

    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.clientId).toBe('c1');
  });
});

describe('GetMyPortfolio — age buckets (injected now)', () => {
  it('assigns each bucket deterministically and tallies summary.byBucket', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    const userId = await makeUser(rbac, { vendedor: 'V' });

    const now = new Date('2026-06-15T00:00:00.000Z');
    // months math: (y2-y1)*12 + (m2-m1), minus 1 if now.day < start.day.
    portfolio.seed({ clientId: 'b03', clientName: 'A 0-3', status: 'active', balanceDue: 0, balanceCurrency: null, vendedor: 'V', startDate: '2026-05-01T00:00:00.000Z' }); // ~1 mo → '0-3'
    portfolio.seed({ clientId: 'b36', clientName: 'B 3-6', status: 'active', balanceDue: 0, balanceCurrency: null, vendedor: 'V', startDate: '2026-02-01T00:00:00.000Z' }); // ~4 mo → '3-6'
    portfolio.seed({ clientId: 'b612', clientName: 'C 6-12', status: 'active', balanceDue: 0, balanceCurrency: null, vendedor: 'V', startDate: '2025-12-01T00:00:00.000Z' }); // ~6 mo → '6-12'
    portfolio.seed({ clientId: 'b12', clientName: 'D 12+', status: 'active', balanceDue: 0, balanceCurrency: null, vendedor: 'V', startDate: '2025-01-01T00:00:00.000Z' }); // ~17 mo → '12+'

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute(userId, now);

    const byId = new Map(res.items.map((i) => [i.clientId, i.ageBucket]));
    expect(byId.get('b03')).toBe('0-3');
    expect(byId.get('b36')).toBe('3-6');
    expect(byId.get('b612')).toBe('6-12');
    expect(byId.get('b12')).toBe('12+');

    expect(res.summary.byBucket).toEqual({ '0-3': 1, '3-6': 1, '6-12': 1, '12+': 1 });
    expect(res.summary.total).toBe(4);
  });

  it('clamps a future start date to bucket 0-3 (negative months → 0)', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    const userId = await makeUser(rbac, { vendedor: 'V' });

    portfolio.seed({ clientId: 'fut', clientName: 'Future', status: 'active', balanceDue: 0, balanceCurrency: null, vendedor: 'V', startDate: '2027-01-01T00:00:00.000Z' });

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute(userId, new Date('2026-06-15T00:00:00.000Z'));

    expect(res.items[0]!.ageBucket).toBe('0-3');
  });

  it('treats the boundary at exactly 6 whole months as 6-12 (lower bound inclusive)', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    const userId = await makeUser(rbac, { vendedor: 'V' });

    // now=2026-06-15, start=2025-12-15 → exactly 6 whole months (day equal → no subtract).
    portfolio.seed({ clientId: 'edge', clientName: 'Edge', status: 'active', balanceDue: 0, balanceCurrency: null, vendedor: 'V', startDate: '2025-12-15T00:00:00.000Z' });

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute(userId, new Date('2026-06-15T00:00:00.000Z'));

    expect(res.items[0]!.ageBucket).toBe('6-12');
  });
});

describe('GetMyPortfolio — hasDebt logic', () => {
  it('hasDebt true when balanceDue > 0 (status active)', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    const userId = await makeUser(rbac, { vendedor: 'V' });

    portfolio.seed({ clientId: 'd1', clientName: 'Debtor', status: 'active', balanceDue: 1500.5, balanceCurrency: 'ARS', vendedor: 'V', startDate: '2026-05-01T00:00:00.000Z' });

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute(userId, new Date('2026-06-15T00:00:00.000Z'));

    const item = res.items[0]!;
    expect(item.hasDebt).toBe(true);
    expect(item.debtAmount).toBe(1500.5);
    expect(item.debtCurrency).toBe('ARS');
    expect(res.summary.withDebt).toBe(1);
  });

  it('hasDebt true when status is late even if balanceDue is 0/null', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    const userId = await makeUser(rbac, { vendedor: 'V' });

    portfolio.seed({ clientId: 'l1', clientName: 'Late', status: 'late', balanceDue: null, balanceCurrency: null, vendedor: 'V', startDate: '2026-05-01T00:00:00.000Z' });

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute(userId, new Date('2026-06-15T00:00:00.000Z'));

    const item = res.items[0]!;
    expect(item.hasDebt).toBe(true);
    expect(item.debtAmount).toBeNull();
    expect(item.debtCurrency).toBeNull();
    expect(res.summary.withDebt).toBe(1);
  });

  it('hasDebt false when balance 0/null and status active', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    const userId = await makeUser(rbac, { vendedor: 'V' });

    portfolio.seed({ clientId: 'ok', clientName: 'Clear', status: 'active', balanceDue: 0, balanceCurrency: 'ARS', vendedor: 'V', startDate: '2026-05-01T00:00:00.000Z' });

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute(userId, new Date('2026-06-15T00:00:00.000Z'));

    expect(res.items[0]!.hasDebt).toBe(false);
    expect(res.summary.withDebt).toBe(0);
    expect(res.summary.active).toBe(1);
  });
});

describe('GetMyPortfolio — openClaims aggregation', () => {
  it('counts only OPEN tickets (resolvedAt null AND archivedAt null) per client', async () => {
    const rbac = new InMemoryRbacUserRepository();
    const portfolio = new InMemoryPortfolioReadRepository();
    const tickets = new InMemoryTicketRepository();
    const userId = await makeUser(rbac, { vendedor: 'V' });

    portfolio.seed({ clientId: 'cA', clientName: 'A', status: 'active', balanceDue: 0, balanceCurrency: null, vendedor: 'V', startDate: '2026-05-01T00:00:00.000Z' });
    portfolio.seed({ clientId: 'cB', clientName: 'B', status: 'active', balanceDue: 0, balanceCurrency: null, vendedor: 'V', startDate: '2026-05-01T00:00:00.000Z' });
    portfolio.seed({ clientId: 'cC', clientName: 'C', status: 'active', balanceDue: 0, balanceCurrency: null, vendedor: 'V', startDate: '2026-05-01T00:00:00.000Z' });

    // cA: 2 open tickets
    await tickets.create({ subject: 's', description: 'd', customerId: 'cA' });
    await tickets.create({ subject: 's', description: 'd', customerId: 'cA' });
    // cB: 1 open + 1 closed (resolvedAt stamped via close) + 1 open-then-archived
    await tickets.create({ subject: 's', description: 'd', customerId: 'cB' });
    const toClose = await tickets.create({ subject: 's', description: 'd', customerId: 'cB' });
    await tickets.close(toClose.id, 'closed');
    const toArchive = await tickets.create({ subject: 's', description: 'd', customerId: 'cB' });
    await tickets.close(toArchive.id, 'closed'); // archive requires closed first
    await tickets.archive(toArchive.id);
    // cC: no tickets

    const uc = new GetMyPortfolio(rbac, portfolio, tickets);
    const res = await uc.execute(userId, new Date('2026-06-15T00:00:00.000Z'));

    const byId = new Map(res.items.map((i) => [i.clientId, i.openClaims]));
    expect(byId.get('cA')).toBe(2);
    expect(byId.get('cB')).toBe(1); // closed + archived excluded
    expect(byId.get('cC')).toBe(0);

    expect(res.summary.withClaims).toBe(2); // cA and cB have >0 open claims
  });
});

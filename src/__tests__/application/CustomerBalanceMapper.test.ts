import { toCustomer } from '@infrastructure/adapters/prisma/PrismaCustomerRepository';

// A fake Prisma Decimal (same pattern as toInvoice tests)
function dec(n: number) {
  return { toNumber: () => n };
}

const BASE_ROW = {
  id: 'c-1',
  name: 'Test Client',
  email: 'test@test.com',
  phone: '123',
  status: 'late',
  address: 'Calle 1',
  city: 'Mercedes',
  country: 'AR',
  login: 'test',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  customAttributes: null,
  grClienteId: '100011',
};

const TTL_MINUTES = 60;
const FRESH_AT = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago (within TTL)
const STALE_AT = new Date(Date.now() - 90 * 60 * 1000); // 90 min ago (past TTL)

describe('toCustomer — balance fields', () => {
  it('maps balanceDue from Prisma Decimal to number', () => {
    const row = { ...BASE_ROW, balanceDue: dec(65722.07), balanceCurrency: 'ARS', lastBalanceAt: FRESH_AT };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceDue).toBe(65722.07);
    expect(c.balanceCurrency).toBe('ARS');
  });

  it('balanceStale=false when balance is fresh (within TTL) for a debtor', () => {
    const row = { ...BASE_ROW, balanceDue: dec(1000), balanceCurrency: 'ARS', lastBalanceAt: FRESH_AT };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceStale).toBe(false);
  });

  it('balanceStale=true when balance is older than TTL for a debtor', () => {
    const row = { ...BASE_ROW, balanceDue: dec(1000), balanceCurrency: 'ARS', lastBalanceAt: STALE_AT };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceStale).toBe(true);
  });

  it('balanceStale=true when lastBalanceAt is null for a debtor (never fetched)', () => {
    const row = { ...BASE_ROW, balanceDue: null, balanceCurrency: null, lastBalanceAt: null };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceStale).toBe(true);
  });

  it('balanceStale=false and balanceDue=0 for a non-debtor (active)', () => {
    const row = { ...BASE_ROW, status: 'active', balanceDue: null, balanceCurrency: null, lastBalanceAt: null };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceDue).toBe(0);
    expect(c.balanceStale).toBe(false);
  });

  it('lastBalanceAt is serialized as ISO string when present', () => {
    const row = { ...BASE_ROW, balanceDue: dec(100), balanceCurrency: 'ARS', lastBalanceAt: FRESH_AT };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.lastBalanceAt).toBe(FRESH_AT.toISOString());
  });

  it('lastBalanceAt is null when null in DB', () => {
    const row = { ...BASE_ROW, balanceDue: null, balanceCurrency: null, lastBalanceAt: null };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.lastBalanceAt).toBeNull();
  });

  it('works without TTL argument (defaults)', () => {
    const row = { ...BASE_ROW, balanceDue: null, balanceCurrency: null, lastBalanceAt: null };
    const c = toCustomer(row);
    // debtor + null lastBalanceAt = stale
    expect(c.balanceStale).toBe(true);
  });

  it('does not break existing fields (backward compat)', () => {
    const row = { ...BASE_ROW, balanceDue: null, balanceCurrency: null, lastBalanceAt: null };
    const c = toCustomer(row);
    expect(c.id).toBe('c-1');
    expect(c.name).toBe('Test Client');
    expect(c.login).toBe('test');
  });
});

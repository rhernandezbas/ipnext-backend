import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { RefreshClientBalanceIfStale, isBalanceOlderThanTtl } from '@application/use-cases/RefreshClientBalanceIfStale';
import { GrClientBalance, GrInvoice } from '@domain/entities/gestionReal';

function makeBalance(grClienteId: string, amount: number): GrClientBalance {
  return { grClienteId, amount, currency: 'ARS', invoicesQty: 1, paymentUrls: {}, invoices: [], raw: {} };
}

function makeGrInvoice(numero: string): GrInvoice {
  return {
    tipo: 'FB', sucursal: '00010', numero, moneda: 'PES',
    fecha: '26-06-2026', fechaVto: '07-07-2026', importe: 1000, saldo: 1000,
    urlPdf: 'https://pdf', cuponPdf: 'https://cupon', paymentUrl: 'https://mp',
  };
}

describe('RefreshClientBalanceIfStale', () => {
  let gr: InMemoryGestionRealPort;
  let mirror: InMemoryClientMirrorRepository;
  let uc: RefreshClientBalanceIfStale;
  const now = new Date('2026-05-27T12:00:00Z');
  const TTL = 60; // minutes

  beforeEach(() => {
    gr = new InMemoryGestionRealPort();
    mirror = new InMemoryClientMirrorRepository();
    uc = new RefreshClientBalanceIfStale(gr, mirror, { now: () => now, ttlMinutes: TTL });
  });

  it('fetches and stores balance when lastBalanceAt is null (never fetched)', async () => {
    gr.balancesByClient['100011'] = makeBalance('100011', 65722.07);

    await uc.execute({ grClienteId: '100011', lastBalanceAt: null });

    expect(gr.balanceCalls).toContain('100011');
    const stored = mirror.balances.get('100011');
    expect(stored?.amount).toBe(65722.07);
    expect(stored?.lastBalanceAt).toEqual(now);
  });

  it('fetches balance when older than TTL (stale)', async () => {
    const staleAt = new Date(now.getTime() - 90 * 60 * 1000); // 90 min ago
    gr.balancesByClient['100011'] = makeBalance('100011', 1000);

    await uc.execute({ grClienteId: '100011', lastBalanceAt: staleAt.toISOString() });

    expect(gr.balanceCalls).toContain('100011');
    expect(mirror.balances.get('100011')?.amount).toBe(1000);
  });

  it('does NOT fetch when balance is fresh (within TTL)', async () => {
    const freshAt = new Date(now.getTime() - 10 * 60 * 1000); // 10 min ago

    await uc.execute({ grClienteId: '100011', lastBalanceAt: freshAt.toISOString() });

    expect(gr.balanceCalls).toHaveLength(0);
  });

  it('does NOT fetch when grClienteId is null (no GR link)', async () => {
    await uc.execute({ grClienteId: null, lastBalanceAt: null });
    expect(gr.balanceCalls).toHaveLength(0);
  });

  it('returns false (did not refresh) when not stale', async () => {
    const freshAt = new Date(now.getTime() - 10 * 60 * 1000);
    const refreshed = await uc.execute({ grClienteId: '100011', lastBalanceAt: freshAt.toISOString() });
    expect(refreshed).toBe(false);
  });

  it('returns true (refreshed) when it fetched new data', async () => {
    gr.balancesByClient['100011'] = makeBalance('100011', 500);
    const refreshed = await uc.execute({ grClienteId: '100011', lastBalanceAt: null });
    expect(refreshed).toBe(true);
  });

  it('also syncs the balance invoices via upsertInvoices when stale', async () => {
    const balance = makeBalance('100011', 2000);
    balance.invoices = [makeGrInvoice('A')];
    gr.balancesByClient['100011'] = balance;

    await uc.execute({ grClienteId: '100011', lastBalanceAt: null });

    const rows = mirror.invoices.filter((r) => r.clientId === '100011');
    expect(rows).toHaveLength(1);
    expect(rows[0].grInvoiceId).toBe('FB-00010-A');
  });

  it('does NOT wipe invoices when GR reports debt but returns an empty list (guard, review #1)', async () => {
    const seed = makeBalance('100011', 2000);
    seed.invoices = [makeGrInvoice('A')];
    gr.balancesByClient['100011'] = seed;
    await uc.execute({ grClienteId: '100011', lastBalanceAt: null }); // seeds invoice A
    expect(mirror.invoices.filter((r) => r.clientId === '100011')).toHaveLength(1);

    // GR now returns debt > 0 but NO itemized invoices (schema drift / partial payload).
    gr.balancesByClient['100011'] = makeBalance('100011', 2000); // invoices: [] by default
    await uc.execute({ grClienteId: '100011', lastBalanceAt: null }); // still stale

    // Guard skipped the sync → the previously synced invoice survives (no $0-vs-debt wipe).
    const rows = mirror.invoices.filter((r) => r.clientId === '100011');
    expect(rows).toHaveLength(1);
    expect(rows[0].grInvoiceId).toBe('FB-00010-A');
  });

  it('DOES clear invoices when the client is fully paid off (amount 0, empty list)', async () => {
    const seed = makeBalance('100011', 2000);
    seed.invoices = [makeGrInvoice('A')];
    gr.balancesByClient['100011'] = seed;
    await uc.execute({ grClienteId: '100011', lastBalanceAt: null }); // seeds invoice A
    expect(mirror.invoices.filter((r) => r.clientId === '100011')).toHaveLength(1);

    // Paid off: amount 0 + empty list is authoritative → replace-all clears the GR rows.
    gr.balancesByClient['100011'] = makeBalance('100011', 0); // invoices: []
    await uc.execute({ grClienteId: '100011', lastBalanceAt: null });

    expect(mirror.invoices.filter((r) => r.clientId === '100011')).toHaveLength(0);
  });

  it('returns false and does NOT throw when GR errors (fallback behavior)', async () => {
    gr.balanceError = new Error('GR timeout');

    const refreshed = await uc.execute({ grClienteId: '100011', lastBalanceAt: null });

    // Should swallow error gracefully
    expect(refreshed).toBe(false);
    // Balance not stored (GR failed)
    expect(mirror.balances.has('100011')).toBe(false);
  });
});

// messaging-inbox-v2 (F1.5, B2) — `isBalanceOlderThanTtl` extracted as a pure,
// exported helper so GetInboxClientContext (RICH-4, mirror-only default path) can
// compute `balance.stale` with the EXACT SAME TTL rule as this collaborator,
// without invoking it (no GR call). Avoids the rule drifting between the two call
// sites. fix-be #6 — renamed from `isBalanceStale`: that name collided (same name,
// different signature/semantics) with the private `isBalanceStale` in
// PrismaCustomerRepository.ts (status-aware, debtor-only check).
describe('isBalanceOlderThanTtl (pure helper, B2)', () => {
  const now = () => new Date('2026-05-27T12:00:00Z');
  const TTL = 60; // minutes

  it('is stale when lastBalanceAt is null (never fetched)', () => {
    expect(isBalanceOlderThanTtl(null, TTL, now)).toBe(true);
  });

  it('is stale when lastBalanceAt is undefined', () => {
    expect(isBalanceOlderThanTtl(undefined, TTL, now)).toBe(true);
  });

  it('is stale when older than the TTL window', () => {
    const staleAt = new Date(now().getTime() - 90 * 60 * 1000).toISOString(); // 90 min ago
    expect(isBalanceOlderThanTtl(staleAt, TTL, now)).toBe(true);
  });

  it('is NOT stale when within the TTL window', () => {
    const freshAt = new Date(now().getTime() - 10 * 60 * 1000).toISOString(); // 10 min ago
    expect(isBalanceOlderThanTtl(freshAt, TTL, now)).toBe(false);
  });

  it('is exactly at the TTL boundary → NOT stale (strictly greater-than semantics)', () => {
    const boundaryAt = new Date(now().getTime() - TTL * 60 * 1000).toISOString(); // exactly 60 min ago
    expect(isBalanceOlderThanTtl(boundaryAt, TTL, now)).toBe(false);
  });
});

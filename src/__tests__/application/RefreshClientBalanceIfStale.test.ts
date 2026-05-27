import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { GrClientBalance } from '@domain/entities/gestionReal';

function makeBalance(grClienteId: string, amount: number): GrClientBalance {
  return { grClienteId, amount, currency: 'ARS', invoicesQty: 1, paymentUrls: {}, raw: {} };
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

  it('returns false and does NOT throw when GR errors (fallback behavior)', async () => {
    gr.balanceError = new Error('GR timeout');

    const refreshed = await uc.execute({ grClienteId: '100011', lastBalanceAt: null });

    // Should swallow error gracefully
    expect(refreshed).toBe(false);
    // Balance not stored (GR failed)
    expect(mirror.balances.has('100011')).toBe(false);
  });
});

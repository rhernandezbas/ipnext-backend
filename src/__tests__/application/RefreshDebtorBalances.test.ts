import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { RefreshDebtorBalances } from '@application/use-cases/RefreshDebtorBalances';
import { GrClient, GrClientBalance } from '@domain/entities/gestionReal';

function makeDebtor(id: string): GrClient {
  return {
    grClienteId: id,
    name: `Deudor ${id}`,
    documento: null,
    email: null,
    phone: null,
    status: 'Deudor',
    statusCode: '2',
    address: null,
    city: null,
    province: null,
    ultimaModificacion: null,
    fechaCreacion: null,
    raw: {},
  };
}

function makeActiveClient(id: string): GrClient {
  return { ...makeDebtor(id), status: 'Activo', statusCode: '1' };
}

function makeBalance(grClienteId: string, amount: number): GrClientBalance {
  return { grClienteId, amount, currency: 'ARS', invoicesQty: 1, paymentUrls: {}, raw: {} };
}

describe('RefreshDebtorBalances', () => {
  let gr: InMemoryGestionRealPort;
  let mirror: InMemoryClientMirrorRepository;
  let state: InMemorySyncStateRepository;
  let uc: RefreshDebtorBalances;
  const now = new Date('2026-05-27T12:00:00Z');

  beforeEach(() => {
    gr = new InMemoryGestionRealPort();
    mirror = new InMemoryClientMirrorRepository();
    state = new InMemorySyncStateRepository();
    uc = new RefreshDebtorBalances(gr, mirror, state, { now: () => now });
  });

  it('fetches balances only for debtors (estado=2)', async () => {
    // Set up both debtors and non-debtors in the mirror
    gr.clients = [makeDebtor('D1'), makeDebtor('D2'), makeActiveClient('A1')];
    gr.balancesByClient['D1'] = makeBalance('D1', 5000);
    gr.balancesByClient['D2'] = makeBalance('D2', 12000);

    const result = await uc.execute();

    // Only 2 balance calls (for D1 and D2), NOT for A1
    expect(gr.balanceCalls).toHaveLength(2);
    expect(gr.balanceCalls).toContain('D1');
    expect(gr.balanceCalls).toContain('D2');
    expect(gr.balanceCalls).not.toContain('A1');

    expect(result.refreshed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('upserts balance data via updateClientBalance', async () => {
    gr.clients = [makeDebtor('D1')];
    gr.balancesByClient['D1'] = makeBalance('D1', 65722.07);

    await uc.execute();

    const stored = mirror.balances.get('D1');
    expect(stored?.amount).toBe(65722.07);
    expect(stored?.currency).toBe('ARS');
    expect(stored?.lastBalanceAt).toEqual(now);
  });

  it('skips one debtor on GR error and continues with the rest', async () => {
    gr.clients = [makeDebtor('D1'), makeDebtor('D2')];
    gr.balancesByClient['D2'] = makeBalance('D2', 1000);

    // Make D1 throw
    const originalFetchClientBalance = gr.fetchClientBalance.bind(gr);
    let callCount = 0;
    gr.fetchClientBalance = async (id: string) => {
      callCount++;
      if (id === 'D1') throw new Error('GR timeout for D1');
      return originalFetchClientBalance(id);
    };

    const result = await uc.execute();

    // D2 balance should be stored
    expect(mirror.balances.get('D2')?.amount).toBe(1000);
    // D1 balance not stored
    expect(mirror.balances.has('D1')).toBe(false);
    // Result counts
    expect(result.refreshed).toBe(1);
    expect(result.errors).toBe(1);
  });

  it('records ok in sync state after success', async () => {
    gr.clients = [makeDebtor('D1')];
    gr.balancesByClient['D1'] = makeBalance('D1', 100);

    await uc.execute();

    const saved = await state.get('gr-debtor-balances');
    expect(saved?.lastResult).toBe('ok');
    expect(saved?.itemsSynced).toBe(1);
  });

  it('records error in sync state on wholesale failure but does not throw', async () => {
    // Make fetchClients throw
    const error = new Error('GR completely down');
    gr.fetchClients = jest.fn().mockRejectedValue(error);

    const result = await uc.execute();

    expect(result.errors).toBeGreaterThan(0);
    const saved = await state.get('gr-debtor-balances');
    expect(saved?.lastResult).toMatch(/error:/);
  });

  it('handles empty debtor list gracefully', async () => {
    gr.clients = [makeActiveClient('A1')]; // no debtors

    const result = await uc.execute();
    expect(result.refreshed).toBe(0);
    expect(gr.balanceCalls).toHaveLength(0);
  });
});

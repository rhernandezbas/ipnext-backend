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

function makeInactiveClient(id: string): GrClient {
  return { ...makeDebtor(id), status: 'Inactivo', statusCode: '3' };
}

function makeBajaClient(id: string): GrClient {
  return { ...makeDebtor(id), status: 'Baja', statusCode: '6' };
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

  it('fetches balances for inactive clients (estado=3)', async () => {
    gr.clients = [makeInactiveClient('I1'), makeInactiveClient('I2'), makeActiveClient('A1')];
    gr.balancesByClient['I1'] = makeBalance('I1', 3000);
    gr.balancesByClient['I2'] = makeBalance('I2', 4500);

    const result = await uc.execute();

    expect(gr.balanceCalls).toContain('I1');
    expect(gr.balanceCalls).toContain('I2');
    expect(gr.balanceCalls).not.toContain('A1');
    expect(result.refreshed).toBe(2);
    expect(result.errors).toBe(0);
  });

  it('fetches balances for baja clients (estado=6)', async () => {
    gr.clients = [makeBajaClient('B1'), makeActiveClient('A1')];
    gr.balancesByClient['B1'] = makeBalance('B1', 9900);

    const result = await uc.execute();

    expect(gr.balanceCalls).toContain('B1');
    expect(gr.balanceCalls).not.toContain('A1');
    expect(result.refreshed).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('fetches balances for debtors, inactives and bajas — excludes activos', async () => {
    gr.clients = [
      makeDebtor('D1'),
      makeInactiveClient('I1'),
      makeBajaClient('B1'),
      makeActiveClient('A1'),
    ];
    gr.balancesByClient['D1'] = makeBalance('D1', 1000);
    gr.balancesByClient['I1'] = makeBalance('I1', 2000);
    gr.balancesByClient['B1'] = makeBalance('B1', 3000);

    const result = await uc.execute();

    expect(gr.balanceCalls).toContain('D1');
    expect(gr.balanceCalls).toContain('I1');
    expect(gr.balanceCalls).toContain('B1');
    expect(gr.balanceCalls).not.toContain('A1');
    expect(result.refreshed).toBe(3);
    expect(result.errors).toBe(0);
  });

  it('deduplicates client ids if the same client appears in multiple status passes', async () => {
    // NOTE: cross-estado dedup (same client in estado=2 AND estado=3) is impossible
    // in real GR — a client has exactly one status. The Set is defensive against
    // dirty data / race conditions (e.g. status changed mid-sweep), NOT against
    // a structural cross-estado overlap.
    // We test the Set logic via same-list duplicates (simulates dirty upstream data).
    gr.clients = [makeDebtor('D1'), makeDebtor('D1')]; // duplicate in same list
    gr.balancesByClient['D1'] = makeBalance('D1', 500);

    const result = await uc.execute();

    // D1 should only be refreshed once (dedup via Set)
    const d1Calls = gr.balanceCalls.filter(id => id === 'D1');
    expect(d1Calls).toHaveLength(1);
    expect(result.refreshed).toBe(1);
  });

  // FIX 1: Aislamiento de fallos por estado en fetchClients
  // Si fetchClients falla para UN estado (ej: '6'), los clientes de los estados
  // que SÍ funcionaron deben refrescarse igual. El fallo de enumeración NO debe
  // abortar el batch completo.

  it('continues refreshing other states when fetchClients fails for one state', async () => {
    gr.clients = [makeDebtor('D1'), makeInactiveClient('I1'), makeBajaClient('B1')];
    gr.balancesByClient['D1'] = makeBalance('D1', 1000);
    gr.balancesByClient['I1'] = makeBalance('I1', 2000);
    // B1 balance never needed — fetchClients for estado='6' will throw

    // Make fetchClients throw only for estado='6'
    const originalFetchClients = gr.fetchClients.bind(gr);
    gr.fetchClients = async (params) => {
      if (params.estado === '6') throw new Error('GR timeout for estado 6');
      return originalFetchClients(params);
    };

    const result = await uc.execute();

    // D1 and I1 (estados '2' and '3') must still be refreshed
    expect(gr.balanceCalls).toContain('D1');
    expect(gr.balanceCalls).toContain('I1');
    // B1 was never enumerated — balance should not be requested
    expect(gr.balanceCalls).not.toContain('B1');

    expect(result.refreshed).toBe(2);
    // The enumeration failure for estado='6' counts as an error
    expect(result.errors).toBe(1);
  });

  it('counts enumeration failures in errors so observability is accurate', async () => {
    gr.clients = [makeDebtor('D1')];
    gr.balancesByClient['D1'] = makeBalance('D1', 500);

    // fetchClients fails for estado='3' AND estado='6'
    const originalFetchClients = gr.fetchClients.bind(gr);
    gr.fetchClients = async (params) => {
      if (params.estado === '3' || params.estado === '6') {
        throw new Error(`GR down for estado ${params.estado}`);
      }
      return originalFetchClients(params);
    };

    const result = await uc.execute();

    // Estado '2' worked — D1 refreshed
    expect(gr.balanceCalls).toContain('D1');
    expect(result.refreshed).toBe(1);
    // Two enumeration failures counted
    expect(result.errors).toBe(2);

    // Sync state should still be 'ok' (partial success — some refreshes succeeded)
    const saved = await state.get('gr-debtor-balances');
    expect(saved?.lastResult).toBe('ok');
  });

  // Observability edge: enumeration SUCCEEDS (clients found) but EVERY balance
  // fetch fails. refreshed=0 with errors>0 — the balance endpoint is down. This
  // must surface as 'error:' in SyncState, not a misleading 'ok'.
  it('records error in sync state when clients were enumerated but ALL balance fetches failed', async () => {
    gr.clients = [makeDebtor('D1'), makeDebtor('D2')];
    // Force every balance fetch to fail (balance endpoint down, enumeration fine)
    gr.fetchClientBalance = async (id: string) => {
      throw new Error(`GR balance endpoint down for ${id}`);
    };

    const result = await uc.execute();

    // Enumeration worked (2 clients), but all balance fetches failed
    expect(result.refreshed).toBe(0);
    expect(result.errors).toBe(2);

    // SyncState must reflect the failure, NOT 'ok'
    const saved = await state.get('gr-debtor-balances');
    expect(saved?.lastResult).toMatch(/error:/);
  });
});

import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import {
  RefreshDebtorBalances,
  FAST_LANE,
  SLOW_LANE,
} from '@application/use-cases/RefreshDebtorBalances';
import { GrClient, GrClientBalance, GrInvoice } from '@domain/entities/gestionReal';

function makeGrInvoice(numero: string): GrInvoice {
  return {
    tipo: 'FB', sucursal: '00010', numero, moneda: 'PES',
    fecha: '26-06-2026', fechaVto: '07-07-2026', importe: 1000, saldo: 1000,
    urlPdf: 'https://pdf', cuponPdf: 'https://cupon', paymentUrl: 'https://mp',
  };
}

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

function makeIncobrableClient(id: string): GrClient {
  return { ...makeDebtor(id), status: 'Incobrable', statusCode: '4' };
}

function makeBajaClient(id: string): GrClient {
  return { ...makeDebtor(id), status: 'Baja', statusCode: '6' };
}

function makeBalance(grClienteId: string, amount: number): GrClientBalance {
  return { grClienteId, amount, currency: 'ARS', invoicesQty: 1, paymentUrls: {}, invoices: [], raw: {} };
}

describe('RefreshDebtorBalances', () => {
  let gr: InMemoryGestionRealPort;
  let mirror: InMemoryClientMirrorRepository;
  let state: InMemorySyncStateRepository;
  /** Carril RAPIDO (estados 1/2/3/4) — el que corre cada hora. */
  let uc: RefreshDebtorBalances;
  /** Carril LENTO (estado 6, Bajas) — el que corre 1 vez por dia. */
  let slow: RefreshDebtorBalances;
  const now = new Date('2026-05-27T12:00:00Z');

  beforeEach(() => {
    gr = new InMemoryGestionRealPort();
    mirror = new InMemoryClientMirrorRepository();
    state = new InMemorySyncStateRepository();
    uc = new RefreshDebtorBalances(gr, mirror, state, FAST_LANE, { now: () => now });
    slow = new RefreshDebtorBalances(gr, mirror, state, SLOW_LANE, { now: () => now });
  });

  // ---------------------------------------------------------------------------
  // LANE-1.1 — el carril rapido incluye a los ACTIVOS
  //
  // Este bloque REVIERTE el comportamiento anterior. Hasta el 2026-08-04 el use
  // case excluia el estado 1 apoyado en este comentario del propio codigo:
  //   "NUNCA se agrega el estado 1 (Activo): verificado en vivo que siempre
  //    devuelve cero facturas"
  // Refutado midiendo GR en vivo: en una muestra aleatoria de 40 clientes
  // estado=1, 33 (82,5%) tenian facturas con saldo. La premisa habia salido de
  // `clientes_consulta` (que NO trae campo de deuda) y no de `cliente`, que es
  // el endpoint que este use case realmente llama.
  // Los `not.toContain('A1')` de la version anterior se INVIRTIERON a proposito:
  // no se esta maquillando un test para que pase, se esta corrigiendo un pin que
  // la realidad refuto.
  // ---------------------------------------------------------------------------

  it('LANE-1.1 — el carril rapido pide el balance de los clientes ACTIVOS', async () => {
    gr.clients = [makeActiveClient('A1'), makeActiveClient('A2')];
    gr.balancesByClient['A1'] = makeBalance('A1', 127561.28);
    gr.balancesByClient['A2'] = makeBalance('A2', 21999);

    const result = await uc.execute();

    expect(gr.calls.some((c) => c.estado === '1')).toBe(true);
    expect(gr.balanceCalls).toContain('A1');
    expect(gr.balanceCalls).toContain('A2');
    expect(result.refreshed).toBe(2);
    expect(result.errors).toBe(0);
  });

  it('LANE-1.1 — el carril rapido cubre activos, deudores, inactivos e incobrables', async () => {
    gr.clients = [
      makeActiveClient('A1'),
      makeDebtor('D1'),
      makeInactiveClient('I1'),
      makeIncobrableClient('N1'),
    ];
    gr.balancesByClient['A1'] = makeBalance('A1', 1000);
    gr.balancesByClient['D1'] = makeBalance('D1', 2000);
    gr.balancesByClient['I1'] = makeBalance('I1', 3000);
    gr.balancesByClient['N1'] = makeBalance('N1', 4000);

    const result = await uc.execute();

    expect(gr.balanceCalls).toEqual(expect.arrayContaining(['A1', 'D1', 'I1', 'N1']));
    expect(result.refreshed).toBe(4);
    expect(result.errors).toBe(0);
  });

  it('LANE-1.1 — el carril rapido NO enumera las Bajas (son del carril lento)', async () => {
    gr.clients = [makeBajaClient('B1'), makeDebtor('D1')];
    gr.balancesByClient['D1'] = makeBalance('D1', 500);

    const result = await uc.execute();

    expect(gr.calls.some((c) => c.estado === '6')).toBe(false);
    expect(gr.balanceCalls).not.toContain('B1');
    expect(gr.balanceCalls).toContain('D1');
    expect(result.refreshed).toBe(1);
  });

  it('fetches balances for debtors (estado=2)', async () => {
    gr.clients = [makeDebtor('D1'), makeDebtor('D2')];
    gr.balancesByClient['D1'] = makeBalance('D1', 5000);
    gr.balancesByClient['D2'] = makeBalance('D2', 12000);

    const result = await uc.execute();

    expect(gr.balanceCalls).toHaveLength(2);
    expect(gr.balanceCalls).toContain('D1');
    expect(gr.balanceCalls).toContain('D2');

    expect(result.refreshed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('fetches balances for inactive clients (estado=3)', async () => {
    gr.clients = [makeInactiveClient('I1'), makeInactiveClient('I2')];
    gr.balancesByClient['I1'] = makeBalance('I1', 3000);
    gr.balancesByClient['I2'] = makeBalance('I2', 4500);

    const result = await uc.execute();

    expect(gr.balanceCalls).toContain('I1');
    expect(gr.balanceCalls).toContain('I2');
    expect(result.refreshed).toBe(2);
    expect(result.errors).toBe(0);
  });

  it('fetches balances for clients in estado Incobrable (4)', async () => {
    gr.clients = [makeIncobrableClient('N1')];
    gr.balancesByClient['N1'] = makeBalance('N1', 7000);

    const result = await uc.execute();

    expect(gr.balanceCalls).toContain('N1');
    expect(result.refreshed).toBe(1);
    expect(result.errors).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // LANE-1.2 — el carril lento cubre las Bajas y SOLO las Bajas
  // ---------------------------------------------------------------------------

  it('LANE-1.2 — el carril lento pide el balance de las Bajas (estado=6)', async () => {
    gr.clients = [makeBajaClient('B1'), makeBajaClient('B2')];
    gr.balancesByClient['B1'] = makeBalance('B1', 9900);
    gr.balancesByClient['B2'] = makeBalance('B2', 1200);

    const result = await slow.execute();

    expect(gr.balanceCalls).toContain('B1');
    expect(gr.balanceCalls).toContain('B2');
    expect(result.refreshed).toBe(2);
    expect(result.errors).toBe(0);
  });

  it('LANE-1.2 — el carril lento NO toca activos, deudores, inactivos ni incobrables', async () => {
    gr.clients = [
      makeBajaClient('B1'),
      makeActiveClient('A1'),
      makeDebtor('D1'),
      makeInactiveClient('I1'),
      makeIncobrableClient('N1'),
    ];
    gr.balancesByClient['B1'] = makeBalance('B1', 9900);

    const result = await slow.execute();

    expect(gr.calls.map((c) => c.estado)).toEqual(['6']);
    expect(gr.balanceCalls).toEqual(['B1']);
    expect(result.refreshed).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // LANE-1.3 — cada carril tiene su propia entity de SyncState
  // ---------------------------------------------------------------------------

  it('LANE-1.3 — los dos carriles escriben entities distintas y no se pisan', async () => {
    gr.clients = [makeDebtor('D1'), makeBajaClient('B1')];
    gr.balancesByClient['D1'] = makeBalance('D1', 100);
    gr.balancesByClient['B1'] = makeBalance('B1', 200);

    await uc.execute();
    await slow.execute();

    const fastState = await state.get(FAST_LANE.entity);
    const slowState = await state.get(SLOW_LANE.entity);

    expect(FAST_LANE.entity).not.toBe(SLOW_LANE.entity);
    expect(fastState?.itemsSynced).toBe(1);
    expect(slowState?.itemsSynced).toBe(1);
  });

  it('LANE-1.3 — el carril rapido CONSERVA la entity gr-debtor-balances', () => {
    // GetFinanceSyncStatus.ts lee literalmente 'gr-debtor-balances' para la
    // tarjeta del dashboard de Finanzas. Si el carril rapido estrenara nombre,
    // esa tarjeta quedaria mostrando la ultima corrida vieja PARA SIEMPRE, sin
    // ningun error. Este test es el pin de esa continuidad.
    expect(FAST_LANE.entity).toBe('gr-debtor-balances');
  });

  it('LANE-1.1 — los carriles declaran exactamente los estados esperados', () => {
    expect([...FAST_LANE.estados].sort()).toEqual(['1', '2', '3', '4']);
    expect([...SLOW_LANE.estados]).toEqual(['6']);
  });

  // ---------------------------------------------------------------------------
  // Comportamiento preexistente — se conserva intacto en el carril rapido
  // ---------------------------------------------------------------------------

  it('upserts balance data via updateBalanceAndInvoices', async () => {
    gr.clients = [makeDebtor('D1')];
    gr.balancesByClient['D1'] = makeBalance('D1', 65722.07);

    await uc.execute();

    const stored = mirror.balances.get('D1');
    expect(stored?.amount).toBe(65722.07);
    expect(stored?.currency).toBe('ARS');
    expect(stored?.lastBalanceAt).toEqual(now);
  });

  it('also syncs the balance invoices via upsertInvoices', async () => {
    gr.clients = [makeDebtor('D1')];
    const balance = makeBalance('D1', 2000);
    balance.invoices = [makeGrInvoice('A'), makeGrInvoice('B')];
    gr.balancesByClient['D1'] = balance;

    await uc.execute();

    const rows = mirror.invoices.filter((r) => r.clientId === 'D1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.grInvoiceId).sort()).toEqual(['FB-00010-A', 'FB-00010-B']);
  });

  it('skips one debtor on GR error and continues with the rest', async () => {
    gr.clients = [makeDebtor('D1'), makeDebtor('D2')];
    gr.balancesByClient['D2'] = makeBalance('D2', 1000);

    const originalFetchClientBalance = gr.fetchClientBalance.bind(gr);
    gr.fetchClientBalance = async (id: string) => {
      if (id === 'D1') throw new Error('GR timeout for D1');
      return originalFetchClientBalance(id);
    };

    const result = await uc.execute();

    expect(mirror.balances.get('D2')?.amount).toBe(1000);
    expect(mirror.balances.has('D1')).toBe(false);
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
    const error = new Error('GR completely down');
    gr.fetchClients = jest.fn().mockRejectedValue(error);

    const result = await uc.execute();

    expect(result.errors).toBeGreaterThan(0);
    const saved = await state.get('gr-debtor-balances');
    expect(saved?.lastResult).toMatch(/error:/);
  });

  it('handles an empty client list gracefully', async () => {
    // Solo Bajas: el carril RAPIDO no las enumera => nada que hacer.
    gr.clients = [makeBajaClient('B1')];

    const result = await uc.execute();
    expect(result.refreshed).toBe(0);
    expect(gr.balanceCalls).toHaveLength(0);
  });

  it('deduplicates client ids if the same client appears in multiple status passes', async () => {
    // NOTE: cross-estado dedup (same client in estado=2 AND estado=3) is impossible
    // in real GR — a client has exactly one status. The Set is defensive against
    // dirty data / race conditions (e.g. status changed mid-sweep), NOT against
    // a structural cross-estado overlap.
    gr.clients = [makeDebtor('D1'), makeDebtor('D1')];
    gr.balancesByClient['D1'] = makeBalance('D1', 500);

    const result = await uc.execute();

    const d1Calls = gr.balanceCalls.filter(id => id === 'D1');
    expect(d1Calls).toHaveLength(1);
    expect(result.refreshed).toBe(1);
  });

  // FIX 1: Aislamiento de fallos por estado en fetchClients
  it('continues refreshing other states when fetchClients fails for one state', async () => {
    gr.clients = [makeDebtor('D1'), makeInactiveClient('I1'), makeIncobrableClient('N1')];
    gr.balancesByClient['D1'] = makeBalance('D1', 1000);
    gr.balancesByClient['I1'] = makeBalance('I1', 2000);
    // N1 balance never needed — fetchClients for estado='4' will throw

    const originalFetchClients = gr.fetchClients.bind(gr);
    gr.fetchClients = async (params) => {
      if (params.estado === '4') throw new Error('GR timeout for estado 4');
      return originalFetchClients(params);
    };

    const result = await uc.execute();

    expect(gr.balanceCalls).toContain('D1');
    expect(gr.balanceCalls).toContain('I1');
    expect(gr.balanceCalls).not.toContain('N1');

    expect(result.refreshed).toBe(2);
    expect(result.errors).toBe(1);
  });

  it('counts enumeration failures in errors so observability is accurate', async () => {
    gr.clients = [makeDebtor('D1')];
    gr.balancesByClient['D1'] = makeBalance('D1', 500);

    const originalFetchClients = gr.fetchClients.bind(gr);
    gr.fetchClients = async (params) => {
      if (params.estado === '3' || params.estado === '4') {
        throw new Error(`GR down for estado ${params.estado}`);
      }
      return originalFetchClients(params);
    };

    const result = await uc.execute();

    expect(gr.balanceCalls).toContain('D1');
    expect(result.refreshed).toBe(1);
    expect(result.errors).toBe(2);

    const saved = await state.get('gr-debtor-balances');
    expect(saved?.lastResult).toBe('ok');
  });

  it('records error in sync state when clients were enumerated but ALL balance fetches failed', async () => {
    gr.clients = [makeDebtor('D1'), makeDebtor('D2')];
    gr.fetchClientBalance = async (id: string) => {
      throw new Error(`GR balance endpoint down for ${id}`);
    };

    const result = await uc.execute();

    expect(result.refreshed).toBe(0);
    expect(result.errors).toBe(2);

    const saved = await state.get('gr-debtor-balances');
    expect(saved?.lastResult).toMatch(/error:/);
  });
});

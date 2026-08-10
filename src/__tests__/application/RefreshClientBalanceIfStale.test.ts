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
    // FW3 mató el margen del carril rápido: el gate interno usa
    // `balanceTtlMinutesForStatus`, cuyo efectivo rápido ES el TTL configurado
    // (60min), sin margen. 3h es simplemente "bien pasado el TTL".
    const staleAt = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3 h ago
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

/**
 * fix wave F3 — **saldo y facturas, una sola escritura atómica.**
 *
 * El split-brain que esto cierra: `updateClientBalance` commiteaba, y si
 * `upsertInvoices` fallaba después, `execute()` devolvía `false` (el caller cree
 * que no pasó nada) con el saldo NUEVO ya en la base y las facturas VIEJAS. Y
 * con `lastBalanceAt` fresco encima, así que nadie lo veía stale.
 */
describe('RefreshClientBalanceIfStale — escritura atómica (F3)', () => {
  const now = new Date('2026-05-27T12:00:00Z');

  it('F3 — si la parte de facturas falla, el saldo NO queda escrito (rollback)', async () => {
    const gr = new InMemoryGestionRealPort();
    const mirror = new InMemoryClientMirrorRepository();
    gr.balancesByClient['100011'] = {
      ...makeBalance('100011', 65722.07),
      invoices: [makeGrInvoice('0001')],
    };
    // Falla inyectada EN LA PARTE DE FACTURAS (la segunda escritura).
    mirror.upsertInvoices = async () => {
      throw new Error('deadlock en Invoice');
    };
    const uc = new RefreshClientBalanceIfStale(gr, mirror, { now: () => now, ttlMinutes: 60 });

    const refreshed = await uc.execute({ grClienteId: '100011', lastBalanceAt: null });

    expect(refreshed).toBe(false);
    // ⚠️ EL PIN: antes de F3 el saldo quedaba commiteado igual.
    expect(mirror.balances.has('100011')).toBe(false);
  });

  it('F3 — el camino feliz sigue escribiendo saldo Y facturas', async () => {
    const gr = new InMemoryGestionRealPort();
    const mirror = new InMemoryClientMirrorRepository();
    gr.balancesByClient['100011'] = {
      ...makeBalance('100011', 1234),
      invoices: [makeGrInvoice('0001')],
    };
    const uc = new RefreshClientBalanceIfStale(gr, mirror, { now: () => now, ttlMinutes: 60 });

    expect(await uc.execute({ grClienteId: '100011', lastBalanceAt: null })).toBe(true);
    expect(mirror.balances.get('100011')?.amount).toBe(1234);
    expect(mirror.invoices).toHaveLength(1);
  });
});

/**
 * fix wave F2 — **single-flight por `grClienteId`.**
 *
 * La carrera real medida en el review: la ficha (`GetClientDetail`) y el bot
 * (`ClienteSaldoResolver`) comparten LA MISMA instancia de este colaborador
 * (pineado por `assistant-composition.test.ts`), y pueden entrar a la vez sobre
 * el mismo cliente — un agente abre la ficha mientras llega el WhatsApp. Sin
 * dedup eran DOS llamadas a GR y DOS escrituras: el último en escribir gana, así
 * que un snapshot VIEJO podía pisar al nuevo y quedar sellado con `lastBalanceAt`
 * fresco. Un saldo viejo con timbre de fresco es exactamente el modo de falla que
 * este change existe para evitar — y encima invisible (nadie lo ve stale).
 *
 * El gate de staleness queda ANTES del dedup, a propósito: es local, barato y
 * per-caller. Lo que se dedupe es el VUELO (fetch + escritura), que es lo caro y
 * lo que puede invertirse. Deploy single-process ⇒ un mapa en memoria alcanza.
 */
describe('RefreshClientBalanceIfStale — single-flight (F2)', () => {
  const now = new Date('2026-05-27T12:00:00Z');
  const TTL = 60;

  /** GR con latencia CONTROLADA: el vuelo no termina hasta que el test lo suelta. */
  function deferredGr() {
    const calls: string[] = [];
    let release!: (b: GrClientBalance) => void;
    const gr = {
      fetchClientBalance: async (grClienteId: string) => {
        calls.push(grClienteId);
        return new Promise<GrClientBalance>((resolve) => {
          release = resolve;
        });
      },
    } as unknown as InMemoryGestionRealPort;
    return { gr, calls, release: (b: GrClientBalance) => release(b) };
  }

  it('F2 — dos execute() concurrentes del MISMO cliente: UNA sola llamada a GR y UNA sola escritura; ambos callers reciben true', async () => {
    const { gr, calls, release } = deferredGr();
    const mirror = new InMemoryClientMirrorRepository();
    const writes: number[] = [];
    // FW2-4: se espía la escritura ATÓMICA — ya no hay una suelta que espiar.
    const originalUpdate = mirror.updateBalanceAndInvoices.bind(mirror);
    mirror.updateBalanceAndInvoices = async (params) => {
      writes.push(params.amount);
      return originalUpdate(params);
    };
    const uc = new RefreshClientBalanceIfStale(gr, mirror, { now: () => now, ttlMinutes: TTL });

    const p1 = uc.execute({ grClienteId: '100011', lastBalanceAt: null });
    const p2 = uc.execute({ grClienteId: '100011', lastBalanceAt: null });
    release(makeBalance('100011', 5000));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(calls).toEqual(['100011']); // ← el pin: UNA llamada, no dos
    expect(writes).toEqual([5000]); // ← una sola escritura ⇒ no hay orden que invertir
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(mirror.balances.get('100011')?.amount).toBe(5000);
  });

  it('F2 — clientes DISTINTOS no se deduplican entre sí (la clave es el grClienteId, no un lock global)', async () => {
    const { gr, calls, release } = deferredGr();
    const mirror = new InMemoryClientMirrorRepository();
    const uc = new RefreshClientBalanceIfStale(gr, mirror, { now: () => now, ttlMinutes: TTL });

    const p1 = uc.execute({ grClienteId: '100011', lastBalanceAt: null });
    const p2 = uc.execute({ grClienteId: '100022', lastBalanceAt: null });
    release(makeBalance('x', 1));
    await Promise.all([p1, p2]);

    expect(calls).toEqual(['100011', '100022']);
  });

  it('F2 — el slot se libera al terminar el vuelo: un execute() POSTERIOR vuelve a llamar a GR', async () => {
    const gr = new InMemoryGestionRealPort();
    const mirror = new InMemoryClientMirrorRepository();
    gr.balancesByClient['100011'] = makeBalance('100011', 1000);
    const uc = new RefreshClientBalanceIfStale(gr, mirror, { now: () => now, ttlMinutes: TTL });

    await uc.execute({ grClienteId: '100011', lastBalanceAt: null });
    await uc.execute({ grClienteId: '100011', lastBalanceAt: null });

    expect(gr.balanceCalls).toEqual(['100011', '100011']);
  });

  it('F2 — un vuelo que FALLA tampoco deja el slot colgado (el próximo caller reintenta)', async () => {
    const gr = new InMemoryGestionRealPort();
    const mirror = new InMemoryClientMirrorRepository();
    gr.balanceError = new Error('GR caido');
    const uc = new RefreshClientBalanceIfStale(gr, mirror, { now: () => now, ttlMinutes: TTL });

    expect(await uc.execute({ grClienteId: '100011', lastBalanceAt: null })).toBe(false);
    gr.balanceError = undefined;
    gr.balancesByClient['100011'] = makeBalance('100011', 777);

    expect(await uc.execute({ grClienteId: '100011', lastBalanceAt: null })).toBe(true);
    expect(mirror.balances.get('100011')?.amount).toBe(777);
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

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
// FW2-2: 3h, no 90min. El TTL efectivo del carril rápido es el configurado + el
// margen que cubre la duración del batch (60 + 60 = 2h), así que 90min quedaron
// DENTRO de la ventana: el sello `lastBalanceAt` se pone cuando el batch toca a
// cada cliente, no cuando la ventana arranca.
const STALE_AT = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 h ago (past the effective TTL)

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

  // customer-balance-unmask (Fase 1) — este test LOCKEABA el bug original
  // ("balanceStale=false and balanceDue=0 for a non-debtor (active)"): un
  // cliente `active` con deuda real terminaba mostrando `balanceDue:0` porque
  // `toCustomer` pisaba a 0 todo status distinto de `late`. Reescrito contra
  // la verdad nueva (spec `customer-balance-truth`, requirement "no GR link
  // means no verified data"). La prueba del revert: reinsertar
  // `if (status !== 'late') return 0;` en `toCustomer` pone este test en rojo
  // (revert-probe M-A, design.md Decisión 9).
  it('S3 — unlinked client with a stray column value: grClienteId:null ⇒ balanceDue:null (nunca 500, nunca 0), sin importar el valor de la columna', () => {
    const row = { ...BASE_ROW, status: 'active', grClienteId: null, balanceDue: dec(500), balanceCurrency: 'ARS' };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceDue).toBeNull();
    expect(c.balanceCurrency).toBeNull();
  });

  it('S4 — linked client, normal path: grClienteId set + row.balanceDue:500 ⇒ balanceDue:500', () => {
    const row = { ...BASE_ROW, status: 'active', grClienteId: 'GR123', balanceDue: dec(500), balanceCurrency: 'ARS' };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceDue).toBe(500);
  });

  /**
   * fix wave F12(c) — `hasGrLink` compara contra `null`/`undefined` EXPLÍCITOS,
   * nunca truthiness. Un revisor vio una mutación transitoria a
   * `Boolean(row.grClienteId)`; esto la deja pineada.
   *
   * La diferencia importa: `grClienteId: ''` es un dato SUCIO, no "sin link".
   * Anularle el balance sería inventar una regla que nadie escribió — y con la
   * misma forma que el bug original: el mapper decidiendo por su cuenta que un
   * número real no vale.
   */
  it('F12c — grClienteId:"" (string vacío, dato sucio) NO es "sin link": el balance pasa (comparación explícita, no truthiness)', () => {
    const row = { ...BASE_ROW, status: 'active', grClienteId: '', balanceDue: dec(500), balanceCurrency: 'ARS' };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceDue).toBe(500);
    expect(c.balanceCurrency).toBe('ARS');
  });

  it('F12c — grClienteId:undefined (columna ausente) SÍ es "sin link"', () => {
    const row = { ...BASE_ROW, status: 'active', grClienteId: undefined, balanceDue: dec(500), balanceCurrency: 'ARS' };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceDue).toBeNull();
  });

  it('S7 — non-ARS currency survives: row.balanceCurrency:"DOL" ⇒ balanceCurrency:"DOL" (nunca default a ARS)', () => {
    const row = { ...BASE_ROW, status: 'active', grClienteId: 'GR123', balanceDue: dec(15), balanceCurrency: 'DOL' };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceCurrency).toBe('DOL');
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

// ─── customer-balance-unmask (Fase 2) — balanceStale status-agnóstico ───────
// spec `balance-staleness-helper`: retira el `isBalanceStale` privado
// (status-aware, `status !== 'late' → false`) y pasa a `isBalanceOlderThanTtl`
// — el MISMO helper que ya usan `RefreshClientBalanceIfStale`/
// `GetInboxClientContext`. `S6` es el discriminante real: hoy un `active` con
// `lastBalanceAt:null` da `balanceStale:false` (el guard está cortocircuitado
// en abierto — proposal.md, "Por qué esto NO repite el FIX-6", punto 1).
describe('toCustomer — balanceStale status-agnóstico (Fase 2)', () => {
  it('S5 — fresh active client: lastBalanceAt=10min, ttl=60 ⇒ balanceStale:false', () => {
    const row = { ...BASE_ROW, status: 'active', balanceDue: dec(1000), balanceCurrency: 'ARS', lastBalanceAt: FRESH_AT };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceStale).toBe(false);
  });

  it('S6 — never fetched, ANY status (incl. active): lastBalanceAt:null ⇒ balanceStale:true', () => {
    const row = { ...BASE_ROW, status: 'active', balanceDue: null, balanceCurrency: null, lastBalanceAt: null };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceStale).toBe(true);
  });

  it('triangulación — active client, lastBalanceAt older than TTL ⇒ balanceStale:true (el guard hoy está cortocircuitado en abierto)', () => {
    const row = { ...BASE_ROW, status: 'active', balanceDue: dec(1000), balanceCurrency: 'ARS', lastBalanceAt: STALE_AT };
    const c = toCustomer(row, TTL_MINUTES);
    expect(c.balanceStale).toBe(true);
  });
});

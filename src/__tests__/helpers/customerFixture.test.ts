/**
 * customer-balance-unmask (Fase 0) — smoke + behavior test de `customerFrom()`.
 *
 * El punto de este helper (design.md Decisión 7): TODO fixture de `Customer` en
 * los tests de esta feature debe nacer del mapper REAL (`toCustomer`), nunca de
 * un objeto armado a mano con un par status/balanceDue imposible — ese fue
 * exactamente el patrón que certificó el masking bug como "tested" (proposal.md,
 * "Por qué los tests no lo cazaron").
 */
import { customerFrom, BASE_ROW, FIXED_NOW } from './customerFixture';

describe('customerFrom', () => {
  // NOTA — Fase 0 (previa al unmask de Fase 1 y al retiro status-aware de
  // Fase 2): estos escenarios usan `status:'late'`, el ÚNICO status para el
  // que el mapper pre-fix ya es idéntico al post-fix (paridad, spec
  // "late client, unchanged parity"). Así el helper queda probado end-to-end
  // sin adelantarse a fases que todavía no corrieron.

  it('delega en el mapper real: un row con deuda produce un Customer con esa deuda', () => {
    const c = customerFrom({ status: 'late', grClienteId: 'GR1', balanceDue: 45000, balanceCurrency: 'ARS' });

    expect(c.balanceDue).toBe(45000);
    expect(c.balanceCurrency).toBe('ARS');
    expect(c.status).toBe('late');
  });

  it('reloj fijo por defecto: lastBalanceAt fresco (10min antes de FIXED_NOW) da balanceStale:false', () => {
    const c = customerFrom({
      status: 'late',
      grClienteId: 'GR1',
      lastBalanceAt: new Date(FIXED_NOW.getTime() - 10 * 60 * 1000),
    });

    expect(c.balanceStale).toBe(false);
  });

  it('BASE_ROW por defecto (sin overrides) no tiene grClienteId ni balance seteado', () => {
    const c = customerFrom({});

    expect(c.grClienteId).toBeNull();
    expect(BASE_ROW.balanceDue).toBeNull();
  });

  it('opts.now permite overridear el reloj fijo cuando el test lo necesita', () => {
    const later = new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000);
    const c = customerFrom(
      { status: 'late', grClienteId: 'GR1', lastBalanceAt: new Date(FIXED_NOW.getTime()) },
      { now: () => later, ttlMinutes: 60 },
    );

    // 2h despues del lastBalanceAt, TTL 60min -> stale.
    expect(c.balanceStale).toBe(true);
  });

  it('BASE_ROW es un row plausible (no vacio) — name/status/login presentes', () => {
    expect(BASE_ROW.name).toBeTruthy();
    expect(BASE_ROW.status).toBeTruthy();
    expect(BASE_ROW.login).toBeTruthy();
  });
});

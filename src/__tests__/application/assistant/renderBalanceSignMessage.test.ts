import { renderBalanceSignMessage } from '@application/use-cases/assistant/renderBalanceSignMessage';

/**
 * ai-assistant-cobranzas (3.7 / D11 / RSP-1) — el SIGNO del saldo decide el mensaje tras un
 * pago verificado. Casos reales del 04-09: Vargas (debt>0), Bravo (debt<0, doble pago).
 */

describe('renderBalanceSignMessage', () => {
  it('RSP-1: debt>0 reconoce el pago y el saldo restante, NUNCA "al día" (caso Vargas)', () => {
    const message = renderBalanceSignMessage({
      debt: 72589.41,
      invoiceCount: 3,
      paidAmount: 41410.56,
    });

    expect(message).not.toMatch(/al día/i);
    expect(message).toContain('3');
    expect(message?.toLowerCase()).toMatch(/recib|pago/);
  });

  it('RSP-1: debt=0 confirma que quedó al día', () => {
    const message = renderBalanceSignMessage({ debt: 0, invoiceCount: 0, paidAmount: 41410.56 });

    expect(message?.toLowerCase()).toMatch(/al día/);
  });

  it('RSP-1: debt<0 confirma al día Y menciona el saldo A FAVOR (caso Bravo)', () => {
    const message = renderBalanceSignMessage({
      debt: -77997.19,
      invoiceCount: 0,
      paidAmount: 77997.19,
    });

    expect(message?.toLowerCase()).toMatch(/al día/);
    expect(message?.toLowerCase()).toMatch(/favor/);
  });

  it('RSP-1: saldo no disponible ⇒ null, no afirma nada', () => {
    const message = renderBalanceSignMessage({ debt: null, invoiceCount: 0, paidAmount: 1000 });

    expect(message).toBeNull();
  });

  it('menciona doble pago cuando se indica', () => {
    const message = renderBalanceSignMessage({
      debt: -77997.19,
      invoiceCount: 0,
      paidAmount: 77997.19,
      posibleDoblePago: true,
    });

    expect(message?.toLowerCase()).toMatch(/dos pagos|doble pago/);
    expect(message?.toLowerCase()).not.toMatch(/devoluci|plazo/);
  });

  it('sin doble pago, no lo menciona', () => {
    const message = renderBalanceSignMessage({
      debt: 0,
      invoiceCount: 0,
      paidAmount: 1000,
      posibleDoblePago: false,
    });

    expect(message?.toLowerCase()).not.toMatch(/dos pagos|doble pago/);
  });

  // ── Fix wave (C3/S2) ──────────────────────────────────────────────────────
  it('C3: con conteo CONOCIDO informa "en N facturas"', () => {
    const message = renderBalanceSignMessage({ debt: 72589.41, invoiceCount: 3, paidAmount: 41410.56 });

    expect(message).toContain('en 3 facturas');
  });

  it('C3: conteo DESCONOCIDO (null) ⇒ omite la cláusula, NUNCA "en 0 facturas"', () => {
    // `cliente.facturas` devuelve `{disponible:false}` en el camino NORMAL (stale o lista
    // vacía, DAT-1): afirmar "en 0 facturas" sobre una deuda de $72.589 es un absurdo que
    // el cliente lee como un error nuestro.
    const message = renderBalanceSignMessage({ debt: 72589.41, invoiceCount: null, paidAmount: 41410.56 });

    expect(message).not.toMatch(/factura/i);
    expect(message).toContain('72.589,41');
  });

  it('C3: conteo 0 tampoco se renderiza', () => {
    const message = renderBalanceSignMessage({ debt: 72589.41, invoiceCount: 0, paidAmount: 41410.56 });

    expect(message).not.toMatch(/0 factura/);
  });

  it('S2: sin importe del pago (GR no lo trae) ⇒ NUNCA "$0,00"', () => {
    const message = renderBalanceSignMessage({ debt: 0, invoiceCount: null, paidAmount: null });

    expect(message).not.toContain('$0,00');
    expect(message?.toLowerCase()).toMatch(/al día/);
  });
});

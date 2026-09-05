/**
 * ai-assistant-cobranzas (3.7 / D11 / RSP-1) — tras un pago verificado, el SIGNO de `debt`
 * (`cliente.saldo`, resuelto en la MISMA corrida, mismo gate de frescura que DFT-2) decide el
 * mensaje. Función PURA, escrita por CÓDIGO — nunca por el modelo (mismo espíritu que
 * `renderInvoiceBlock`, D3).
 *
 * `debt > 0` ⇒ sigue debiendo, JAMÁS "estás al día". `debt = 0` ⇒ al día. `debt < 0` ⇒ al día
 * Y menciona el saldo A FAVOR. El recibo sólo DISPARA la verificación — nunca es por sí solo
 * prueba de que la deuda quedó saldada (RSP-1).
 */

export interface RenderBalanceSignMessageInput {
  /** `cliente.saldo.debt` de la MISMA corrida. `null` = no disponible (DFT-2). */
  debt: number | null;
  /**
   * Facturas abiertas restantes, para mencionar "en N facturas" cuando `debt > 0`.
   *
   * ⚠️ fix wave C3 — `null` (o `0`) significa **no lo sabemos**, y entonces la cláusula se
   * OMITE. `cliente.facturas` devuelve `{disponible:false}` en el camino NORMAL (saldo stale
   * o lista vacía, DAT-1), y con un `0` por defecto el bot mandaba "te quedan $72.589,41
   * pendientes en 0 facturas": un absurdo que el cliente lee —con razón— como un error
   * nuestro sobre su propia plata.
   */
  invoiceCount: number | null;
  /**
   * Importe del pago que disparó la verificación (DAT-4) — sólo para el reconocimiento.
   * `null` = GR no lo trajo ⇒ se reconoce el pago SIN cifra (fix wave S2: "$0,00" es peor
   * que no decir el monto).
   */
  paidAmount: number | null;
  /** `true` ⇒ 2+ recibos vigentes del día con el mismo importe (D9/INT-4/R5). */
  posibleDoblePago?: boolean;
}

function formatMoney(n: number): string {
  return Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function doublePaymentNote(): string {
  return 'Vemos dos pagos por el mismo importe hoy — si fue un error, avisanos.';
}

/**
 * `null` si `cliente.saldo` no está disponible en la corrida: el bot NO afirma ni "te queda
 * saldo" ni "estás al día" (RSP-1, scenario "saldo no disponible tras verificar el pago").
 */
export function renderBalanceSignMessage(input: RenderBalanceSignMessageInput): string | null {
  if (input.debt === null) return null;

  const lines: string[] = [];
  const doubleNote = input.posibleDoblePago ? doublePaymentNote() : null;

  // S2 — sin importe no se inventa un "$0,00": se reconoce el pago a secas.
  const recibimos =
    input.paidAmount !== null && Number.isFinite(input.paidAmount) && input.paidAmount > 0
      ? `Recibimos tu pago de $${formatMoney(input.paidAmount)}.`
      : 'Recibimos tu pago.';

  // C3 — la cláusula "en N facturas" sólo se dice cuando N se CONOCE.
  const count = input.invoiceCount;
  const enFacturas =
    count !== null && Number.isFinite(count) && count > 0
      ? ` en ${count} factura${count === 1 ? '' : 's'}`
      : '';

  if (input.debt > 0) {
    lines.push(`${recibimos} Te quedan $${formatMoney(input.debt)} pendientes${enFacturas}.`);
  } else if (input.debt === 0) {
    lines.push(`${recibimos} Quedaste al día.`);
  } else {
    lines.push(`${recibimos} Quedaste al día y con un saldo a favor de $${formatMoney(input.debt)}.`);
  }

  if (doubleNote) lines.push(doubleNote);

  return lines.join(' ');
}

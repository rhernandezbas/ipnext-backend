import type { AssistantInvoiceFact } from '@domain/ports/AssistantInvoicesReader';

/**
 * ai-assistant-cobranzas (3.2 / D3 / REN-1) — bloque "Detalle por factura", escrito por
 * CÓDIGO a partir de los HECHOS de `cliente.facturas`, nunca por el modelo. Se ANEXA
 * DESPUÉS de la verificación SEC-4 sobre `generated.text` — este bloque nunca pasa por el
 * verificador de números porque nunca fue redactado por el modelo (D3).
 */

export interface RenderInvoiceBlockInput {
  invoices: AssistantInvoiceFact[];
  /** `Client.grPaymentUrl` — "pagar todo junto" (D8). `null` = no disponible. */
  totalPaymentUrl: string | null;
  /**
   * Alias de MercadoPago/transferencia por el que corresponde pagar, cuando el medio de pago
   * es un alias (no un link directo). Presente ⇒ el bloque aclara la titularidad, para que el
   * cliente no dude a quién le está transfiriendo.
   */
  payByAlias?: string | null;
}

/**
 * REN-1 — la aclaración COMPLETA del alias. La segunda oración no es adorno: el fraude típico
 * es un alias parecido con otro titular, y el cliente sólo puede detectarlo si sabe qué tiene
 * que ver antes de confirmar la transferencia.
 */
const ALIAS_DISCLAIMER = 'titular IPNEXT S.A., CUIT 30-70849985-0. Si ves otro dato, no transfieras';

function formatMoney(n: number): string {
  return n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function invoiceLine(inv: AssistantInvoiceFact): string {
  const parts = [`${inv.tipo} ${inv.numero} — vence ${inv.vencimiento} — saldo $${formatMoney(inv.saldo)}`];
  if (inv.paymentUrl) parts.push(`Pagar: ${inv.paymentUrl}`);
  return parts.join('\n');
}

/**
 * `null` si no hay facturas — el bloque NUNCA afirma "al día" por ausencia de facturas
 * (DFT-2/DAT-1): esa decisión es exclusiva de `cliente.saldo`.
 */
export function renderInvoiceBlock(input: RenderInvoiceBlockInput): string | null {
  if (input.invoices.length === 0) return null;

  const lines = ['Detalle por factura (cada link paga solo esa):', ''];
  for (const inv of input.invoices) {
    lines.push(invoiceLine(inv));
    lines.push('');
  }

  if (input.totalPaymentUrl) {
    lines.push(`Para pagar todo junto: ${input.totalPaymentUrl}`);
  }

  if (input.payByAlias) {
    lines.push(`Alias: ${input.payByAlias} (${ALIAS_DISCLAIMER})`);
  }

  return lines.join('\n').trim();
}

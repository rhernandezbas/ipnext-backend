import type { InvoiceDetailInvoice } from '@domain/ports/InvoiceDetailReader';

/**
 * whatsapp-invoice-detail-quickreply (Phase 4, QR-4, design "fallbacks always
 * answer, and never claim 'al día'") — copia EXACTA acordada con el dueño.
 * Se envía cuando el lookup de GR falla (mirror stale, GR inalcanzable, o el
 * reader lanza) — NUNCA se reformula, y jamás se manda vacío/sin respuesta.
 */
export const GR_LOOKUP_FAILED_MESSAGE =
  '¡Hola! Por ahora no pudimos traer el detalle de tu cuenta. En un rato lo revisamos y te confirmamos por acá. — IPNEXT Cobranzas';

/**
 * whatsapp-invoice-detail-quickreply (Phase 4, QR-3) — copia EXACTA acordada
 * con el dueño para CERO facturas pendientes.
 *
 * GUARDRAIL DE DISEÑO (no reformular): esta string NUNCA debe decir ni implicar
 * "estás al día" — esa afirmación es exclusiva de la fuente de saldo
 * autorizada (mismo guardrail que `ClienteFacturasResolver`/D7: una lista vacía
 * puede significar "no debe nada" O "el espejo no tiene sus facturas", y desde
 * acá no se distinguen).
 */
export const NO_PENDING_INVOICES_MESSAGE =
  '¡Hola! No encontramos facturas pendientes en tu cuenta en este momento. Si tenés alguna duda, contanos y te ayudamos. — IPNEXT Cobranzas';

const DIVIDER = '─────────────────────';

function formatMoney(n: number): string {
  return n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** QR-3 — número, fecha de vencimiento, saldo, "Ver" (urlPdf) y "Pagar ahora" (paymentUrl, si vino). */
function invoiceBlock(inv: InvoiceDetailInvoice): string {
  const lines = [
    `${inv.tipo} ${inv.numero}`,
    `Vence: ${inv.vencimiento}`,
    `Saldo: $${formatMoney(inv.saldo)}`,
  ];
  if (inv.pdfUrl) lines.push(`Ver: ${inv.pdfUrl}`);
  // Design "no post-due line in v1" — un solo link "Pagar ahora", jamás una
  // segunda etiqueta post-vencimiento sobre el MISMO `paymentUrl`.
  if (inv.paymentUrl) lines.push(`Pagar ahora: ${inv.paymentUrl}`);
  return lines.join('\n');
}

/**
 * Pura, total — nunca throws. `invoices === null` representa "el lookup de GR
 * falló" (QR-4): el orchestrator SIEMPRE llama esta función, aun en su rama de
 * catch, para nunca dejar un tap sin respuesta. `invoices === []` es el caso de
 * éxito con cero facturas abiertas (QR-3, escenario "customer with zero pending
 * invoices").
 */
export function renderInvoiceDetailReply(invoices: InvoiceDetailInvoice[] | null): string {
  if (invoices === null) return GR_LOOKUP_FAILED_MESSAGE;
  if (invoices.length === 0) return NO_PENDING_INVOICES_MESSAGE;

  return invoices.map(invoiceBlock).join(`\n${DIVIDER}\n`);
}

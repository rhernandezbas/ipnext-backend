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

/**
 * fix wave (review adversarial, BUG 3) — tope DURO de largo del mensaje. Misma
 * convención de 1400 chars por mensaje que `splitForWhatsapp` (el límite real
 * de Chatwoot/WhatsApp es ~4096, 1400 es el margen que ya usa el repo). Acá NO
 * se parte en chunks a propósito: un tap del botón se responde con UN mensaje.
 */
export const MAX_REPLY_LENGTH = 1400;

/**
 * fix wave (review adversarial, BUG 3) — cuántas facturas se citan como máximo.
 * Cada bloque ronda los 200-260 chars, así que 5 bloques + la línea de cierre
 * entran cómodos en 1400; el recorte por largo de abajo es igual el que GARANTIZA
 * el tope (una url larguísima puede inflar un solo bloque).
 */
export const MAX_INVOICES_IN_REPLY = 5;

/**
 * fix wave (review adversarial, BUG 3) — cierre cuando quedaron facturas afuera.
 * Recortar en SILENCIO le haría creer al cliente que esas son todas sus facturas
 * (y que el resto ya está paga): peor que no contestar.
 */
export const MORE_INVOICES_MESSAGE =
  'Tenés más facturas pendientes además de estas. Escribinos por acá y un asesor te pasa el detalle completo. — IPNEXT Cobranzas';

function formatMoney(n: number): string {
  return n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * fix wave (review adversarial, BUG 2) — el puerto entrega el vencimiento en ISO
 * (`2026-09-10T00:00:00.000Z`) y antes se interpolaba CRUDO en el mensaje al
 * cliente. Se formatea a DD/MM/YYYY a mano, a propósito:
 * - `toLocaleDateString('es-AR')` depende de que el build de Node tenga full-ICU;
 *   sin ICU degrada en silencio a otro formato en prod.
 * - Se lee la parte de FECHA del string ISO, sin construir un `Date`: un
 *   `new Date(iso).getDate()` en TZ Argentina (UTC-3) devolvería el día ANTERIOR
 *   para un vencimiento a medianoche UTC.
 * Cualquier valor que no sea un ISO reconocible se devuelve tal cual (nunca se
 * inventa una fecha).
 */
function formatDueDate(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!match) return raw;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

/** QR-3 — número, fecha de vencimiento, saldo, "Ver" (urlPdf) y "Pagar ahora" (paymentUrl, si vino). */
function invoiceBlock(inv: InvoiceDetailInvoice): string {
  const lines = [
    `${inv.tipo} ${inv.numero}`,
    `Vence: ${formatDueDate(inv.vencimiento)}`,
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

  // BUG 3 — dos redes, no una: el tope de CANTIDAD (previsible para el operador)
  // y el tope de LARGO (el que de verdad garantiza que Chatwoot acepte el envío;
  // sin él, un mensaje demasiado largo hacía throw en `sendMessage` y el cliente
  // que tocó el botón se quedaba sin NINGUNA respuesta, ni siquiera el fallback).
  let shown = Math.min(invoices.length, MAX_INVOICES_IN_REPLY);
  let text = buildReply(invoices, shown);
  while (text.length > MAX_REPLY_LENGTH && shown > 1) {
    shown -= 1;
    text = buildReply(invoices, shown);
  }
  if (text.length > MAX_REPLY_LENGTH) {
    // Caso extremo: UNA sola factura ya no entra (p. ej. una url gigante). Se
    // corta en el último salto de línea que entra, para no partir un link al
    // medio, y se responde igual — mudo es la única salida inaceptable.
    const cut = text.slice(0, MAX_REPLY_LENGTH);
    const lastBreak = cut.lastIndexOf('\n');
    text = lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
  }
  return text;
}

function buildReply(invoices: InvoiceDetailInvoice[], shown: number): string {
  const blocks = invoices.slice(0, shown).map(invoiceBlock);
  const body = blocks.join(`\n${DIVIDER}\n`);
  return invoices.length > shown ? `${body}\n${DIVIDER}\n${MORE_INVOICES_MESSAGE}` : body;
}

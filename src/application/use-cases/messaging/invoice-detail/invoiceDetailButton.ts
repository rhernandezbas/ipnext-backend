/**
 * whatsapp-invoice-detail-quickreply (Phase 1, QR-1, design "detect the tap by
 * exact button title, and make drift impossible at creation") — constante
 * ÚNICA de título usada tanto por `CreateTemplate.assertValidButton` (rechaza
 * un botón `quickReply` cuyo título no sea este, exacto — imposible crear un
 * template que este webhook no reconocería) como por el webhook al detectar el
 * tap. Zero imports desde `assistant/*` (QR-2, aislamiento total).
 */
export const INVOICE_DETAIL_BUTTON_TITLE = 'Ver mis facturas';

/**
 * Match trim + case-insensitive EXACTO — nunca substring. Chatwoot no captura
 * id/payload del botón (confirmado en vivo, design §"trigger detection"): el
 * `content` inbound es el título verbatim del botón tapeado, así que esta es
 * la ÚNICA señal disponible.
 */
export function isInvoiceDetailTrigger(content: string): boolean {
  return content.trim().toLowerCase() === INVOICE_DETAIL_BUTTON_TITLE.toLowerCase();
}

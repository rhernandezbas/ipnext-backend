/**
 * whatsapp-invoice-detail-quickreply (Phase 1, QR-1) — `isInvoiceDetailTrigger`
 * es la ÚNICA señal disponible: Chatwoot no captura id/payload del botón, solo
 * el `content` verbatim del tap (design "detect the tap by exact button
 * title"). Match trim + case-insensitive EXACTO — NUNCA substring, misma
 * disciplina que `OPT_OUT_KEYWORDS`.
 */
import { INVOICE_DETAIL_BUTTON_TITLE, isInvoiceDetailTrigger } from '@application/use-cases/messaging/invoice-detail/invoiceDetailButton';

describe('invoiceDetailButton (QR-1)', () => {
  it('exporta la constante de título esperada por el diseño', () => {
    expect(INVOICE_DETAIL_BUTTON_TITLE).toBe('Ver mis facturas');
  });

  it('match exacto → dispara el trigger', () => {
    expect(isInvoiceDetailTrigger('Ver mis facturas')).toBe(true);
  });

  it('case-insensitive → dispara el trigger', () => {
    expect(isInvoiceDetailTrigger('VER MIS FACTURAS')).toBe(true);
  });

  it('con espacios de borde (trim) → dispara el trigger', () => {
    expect(isInvoiceDetailTrigger('  Ver mis facturas  ')).toBe(true);
  });

  it('substring (contiene el título pero no es igual) → NO dispara', () => {
    expect(isInvoiceDetailTrigger('quiero ver mis facturas')).toBe(false);
  });

  it('contenido no relacionado → NO dispara', () => {
    expect(isInvoiceDetailTrigger('hola, ¿cómo estás?')).toBe(false);
  });

  it('string vacío → NO dispara', () => {
    expect(isInvoiceDetailTrigger('')).toBe(false);
  });
});

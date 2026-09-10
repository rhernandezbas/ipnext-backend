/**
 * whatsapp-invoice-detail-quickreply (Phase 4, QR-3/QR-4, design "fallbacks
 * always answer, and never claim 'al día'") — formateador PURO, sin doubles:
 * `invoices === null` representa "el lookup de GR falló" (QR-4, el orchestrator
 * nunca deja que ese catch se propague sin texto); `invoices === []` representa
 * "el cliente no tiene facturas pendientes" (éxito, lista vacía).
 */
import {
  renderInvoiceDetailReply,
  GR_LOOKUP_FAILED_MESSAGE,
  NO_PENDING_INVOICES_MESSAGE,
  MAX_INVOICES_IN_REPLY,
  MAX_REPLY_LENGTH,
} from '@application/use-cases/messaging/invoice-detail/renderInvoiceDetailReply';
import type { InvoiceDetailInvoice } from '@domain/ports/InvoiceDetailReader';

const invoice = (overrides: Partial<InvoiceDetailInvoice> = {}): InvoiceDetailInvoice => ({
  tipo: 'Factura',
  numero: '0001-00012345',
  vencimiento: '2026-09-10T00:00:00.000Z',
  saldo: 41410.56,
  pdfUrl: 'https://gr.example/pdf/1',
  paymentUrl: 'https://mp.example/pay/1',
  ...overrides,
});

describe('renderInvoiceDetailReply (QR-3/QR-4)', () => {
  it('owner-locked: string de fallback de lookup fallido, EXACTA', () => {
    expect(GR_LOOKUP_FAILED_MESSAGE).toBe(
      '¡Hola! Por ahora no pudimos traer el detalle de tu cuenta. En un rato lo revisamos y te confirmamos por acá. — IPNEXT Cobranzas',
    );
  });

  it('owner-locked: string de cero facturas pendientes, EXACTA', () => {
    expect(NO_PENDING_INVOICES_MESSAGE).toBe(
      '¡Hola! No encontramos facturas pendientes en tu cuenta en este momento. Si tenés alguna duda, contanos y te ayudamos. — IPNEXT Cobranzas',
    );
  });

  it('la string de cero facturas NUNCA sugiere "al día" (guardrail del diseño)', () => {
    expect(NO_PENDING_INVOICES_MESSAGE.toLowerCase()).not.toContain('al día');
    expect(NO_PENDING_INVOICES_MESSAGE.toLowerCase()).not.toContain('al dia');
  });

  it('invoices === null (lookup falló) → devuelve el mensaje de fallback verbatim', () => {
    expect(renderInvoiceDetailReply(null)).toBe(GR_LOOKUP_FAILED_MESSAGE);
  });

  it('invoices === [] (cero pendientes) → devuelve el mensaje neutro verbatim', () => {
    expect(renderInvoiceDetailReply([])).toBe(NO_PENDING_INVOICES_MESSAGE);
  });

  it('UNA factura con paymentUrl → itemiza número/vencimiento/saldo + Ver + Pagar ahora', () => {
    const text = renderInvoiceDetailReply([invoice()]);

    expect(text).toContain('0001-00012345');
    expect(text).toContain('41.410,56');
    expect(text).toContain('https://gr.example/pdf/1');
    expect(text).toContain('https://mp.example/pay/1');
    expect(text).toMatch(/Pagar ahora/);
    expect(text).toMatch(/Ver/);
  });

  it('paymentUrl null → omite la línea "Pagar ahora" (no inventa un link)', () => {
    const text = renderInvoiceDetailReply([invoice({ paymentUrl: null })]);

    expect(text).not.toMatch(/Pagar ahora/);
    expect(text).toContain('0001-00012345');
  });

  it('N facturas (>1) → cada una itemizada, separadas por un divisor', () => {
    const text = renderInvoiceDetailReply([
      invoice({ numero: '0001-1' }),
      invoice({ numero: '0001-2', paymentUrl: null }),
    ]);

    expect(text).toContain('0001-1');
    expect(text).toContain('0001-2');
    // Triangulación: el divisor separa AMBOS bloques (no es un artefacto de un solo item).
    const idx1 = text.indexOf('0001-1');
    const idx2 = text.indexOf('0001-2');
    const between = text.slice(idx1, idx2);
    expect(between.length).toBeGreaterThan('0001-1\n'.length);
    expect(between).toMatch(/[-─]{3,}/);
  });

  // ── fix wave (review adversarial) — BUG 2: fecha legible, nunca ISO crudo ──
  it('el vencimiento se muestra como DD/MM/YYYY, jamás el ISO crudo', () => {
    const text = renderInvoiceDetailReply([invoice({ vencimiento: '2026-09-10T00:00:00.000Z' })]);

    expect(text).toContain('Vence: 10/09/2026');
    expect(text).not.toContain('2026-09-10');
    expect(text).not.toContain('T00:00:00');
    expect(text).not.toContain('Z');
  });

  it('vencimiento vacío (fila sin fecha) → la línea "Vence" no inventa una fecha', () => {
    const text = renderInvoiceDetailReply([invoice({ vencimiento: '' })]);

    expect(text).toContain('0001-00012345');
    expect(text).not.toMatch(/Vence: \S/);
  });

  // ── fix wave (review adversarial) — BUG 3: tope de facturas y de largo ─────
  it('más facturas que el tope → recorta, avisa que hay más, y NUNCA excede el largo seguro', () => {
    const many = Array.from({ length: MAX_INVOICES_IN_REPLY + 7 }, (_, i) =>
      invoice({ numero: `0001-${i + 1}` }),
    );

    const text = renderInvoiceDetailReply(many);

    expect(text.length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
    expect(text).toContain('0001-1'); // las primeras SÍ se citan
    expect(text).not.toContain(`0001-${MAX_INVOICES_IN_REPLY + 7}`); // la última NO
    // No se recorta en silencio: el mensaje avisa que hay más.
    expect(text.toLowerCase()).toContain('más facturas');
  });

  it('facturas con links larguísimos → el mensaje sigue dentro del largo seguro', () => {
    const longUrl = `https://mp.example/pay/${'x'.repeat(600)}`;
    const many = Array.from({ length: MAX_INVOICES_IN_REPLY }, (_, i) =>
      invoice({ numero: `0002-${i + 1}`, pdfUrl: longUrl, paymentUrl: longUrl }),
    );

    expect(renderInvoiceDetailReply(many).length).toBeLessThanOrEqual(MAX_REPLY_LENGTH);
  });
});

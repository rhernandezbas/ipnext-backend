import { renderInvoiceBlock } from '@application/use-cases/assistant/renderInvoiceBlock';
import type { AssistantInvoiceFact } from '@domain/ports/AssistantInvoicesReader';

/**
 * ai-assistant-cobranzas (3.2 / D3 / REN-1) — bloque determinístico de facturas, escrito por
 * CÓDIGO, nunca por el modelo. Función pura: nunca pasa por SEC-4 (nunca fue redactado por el
 * modelo, D3).
 */

function invoice(overrides: Partial<AssistantInvoiceFact> = {}): AssistantInvoiceFact {
  return {
    tipo: 'Factura',
    numero: '0001-00012345',
    vencimiento: '2026-09-10',
    saldo: 12345.67,
    pdfUrl: 'https://gestionreal.example.com/pdf/12345',
    couponPdfUrl: 'https://gestionreal.example.com/cupon/12345',
    paymentUrl: 'https://gestionreal.example.com/pagar/12345',
    ...overrides,
  };
}

describe('renderInvoiceBlock', () => {
  it('REN-1: null si no hay facturas', () => {
    expect(renderInvoiceBlock({ invoices: [], totalPaymentUrl: null })).toBeNull();
  });

  it('REN-1: lista cada factura con su paymentUrl', () => {
    const block = renderInvoiceBlock({
      invoices: [
        invoice({ numero: '0001-00012345', saldo: 12345.67, paymentUrl: 'https://pay/1' }),
        invoice({ numero: '0001-00012346', saldo: 5000, paymentUrl: 'https://pay/2' }),
      ],
      totalPaymentUrl: null,
    });

    expect(block).toContain('0001-00012345');
    expect(block).toContain('https://pay/1');
    expect(block).toContain('0001-00012346');
    expect(block).toContain('https://pay/2');
  });

  it('REN-1: incluye el link de pago TOTAL cuando viene Client.grPaymentUrl', () => {
    const block = renderInvoiceBlock({
      invoices: [invoice()],
      totalPaymentUrl: 'https://gestionreal.example.com/pagar/todo-junto',
    });

    expect(block).toContain('https://gestionreal.example.com/pagar/todo-junto');
  });

  it('REN-1: sin link total, no inventa ninguno', () => {
    const block = renderInvoiceBlock({ invoices: [invoice()], totalPaymentUrl: null });

    // El bloque no debe tener una URL adicional que no venga de las facturas o del total.
    const urls = block?.match(/https?:\/\/\S+/g) ?? [];
    expect(urls).toEqual(['https://gestionreal.example.com/pagar/12345']);
  });

  it('REN-1: aclara el alias con titular y CUIT cuando corresponde pagar por alias', () => {
    const block = renderInvoiceBlock({
      invoices: [invoice({ paymentUrl: null })],
      totalPaymentUrl: null,
      payByAlias: 'ipnext.cobros',
    });

    expect(block).toContain('ipnext.cobros');
    expect(block).toContain('IPNEXT S.A.');
    expect(block).toContain('30-70849985-0');
  });

  it('REN-1: sin alias, no menciona titular ni CUIT', () => {
    const block = renderInvoiceBlock({ invoices: [invoice()], totalPaymentUrl: null });

    expect(block).not.toContain('CUIT');
  });

  it('una factura sin paymentUrl propio no rompe el render', () => {
    const block = renderInvoiceBlock({
      invoices: [invoice({ paymentUrl: null })],
      totalPaymentUrl: null,
    });

    expect(block).toContain('0001-00012345');
  });
});

/**
 * ai-assistant-cobranzas (2.3 / DAT-2) — RED: puerto angosto, anclado al cliente, sin PII.
 *
 * Compilation-only + shape test (molde `domain/ports/rbac-contracts.test.ts`): el archivo
 * todavía no existe, así que `ts-jest` no compila este test hasta 2.3 (GREEN).
 *
 * DAT-2: la proyección MUST NOT incluir `customerName` ni ningún campo de identidad. Se
 * bloquea la regresión con un chequeo de claves EXACTAS (no sólo "están las que quiero"),
 * para que agregar `customerName` a `AssistantInvoiceFact` en el futuro rompa este test.
 */
import type {
  AssistantInvoicesReader,
  AssistantInvoiceFact,
} from '../../../domain/ports/AssistantInvoicesReader';

function makeFact(overrides: Partial<AssistantInvoiceFact> = {}): AssistantInvoiceFact {
  return {
    tipo: 'FC',
    numero: '0001-00001234',
    vencimiento: '2026-09-10',
    saldo: 15000,
    pdfUrl: 'https://gr.example/invoice.pdf',
    couponPdfUrl: 'https://gr.example/coupon.pdf',
    paymentUrl: 'https://mpago.example/pay/1',
    ...overrides,
  };
}

function makeReader(facts: AssistantInvoiceFact[]): AssistantInvoicesReader {
  return {
    listOpenByClientId: async () => facts,
    // D8 — el link "pagar todo junto" (`Client.grPaymentUrl`) vive en el MISMO puerto: es un
    // dato de cobranza anclado al cliente, no una razón para cargar la ficha entera.
    findTotalPaymentUrlByClientId: async () => null,
  };
}

describe('AssistantInvoicesReader — puerto angosto sin PII (DAT-2)', () => {
  it('devuelve las facturas abiertas del cliente', async () => {
    const reader = makeReader([makeFact()]);

    const facts = await reader.listOpenByClientId('client-1');

    expect(facts).toHaveLength(1);
    expect(facts[0].saldo).toBe(15000);
  });

  it('la proyección es EXACTAMENTE tipo/numero/vencimiento/saldo/pdfUrl/couponPdfUrl/paymentUrl — sin PII', async () => {
    const reader = makeReader([makeFact()]);

    const [fact] = await reader.listOpenByClientId('client-1');

    expect(Object.keys(fact).sort()).toEqual(
      [
        'couponPdfUrl',
        'numero',
        'paymentUrl',
        'pdfUrl',
        'saldo',
        'tipo',
        'vencimiento',
      ].sort(),
    );
    // Ningún campo de identidad del cliente — ver DAT-2 scenario "la proyección es libre de PII".
    expect(fact).not.toHaveProperty('customerName');
  });

  it('pdfUrl/couponPdfUrl/paymentUrl pueden ser null (GR no siempre los trae)', async () => {
    const reader = makeReader([
      makeFact({ pdfUrl: null, couponPdfUrl: null, paymentUrl: null }),
    ]);

    const [fact] = await reader.listOpenByClientId('client-1');

    expect(fact.pdfUrl).toBeNull();
    expect(fact.couponPdfUrl).toBeNull();
    expect(fact.paymentUrl).toBeNull();
  });

  it('lista vacía cuando el cliente no tiene facturas abiertas', async () => {
    const reader = makeReader([]);

    await expect(reader.listOpenByClientId('client-sin-deuda')).resolves.toEqual([]);
  });
});

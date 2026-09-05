/**
 * ai-assistant-cobranzas (2.4 / DAT-3 / D8) — RED: `UpdateBalanceAndInvoicesParams` gana
 * `paymentUrl?: string | null` ("pagar todo junto", de `balance.paymentUrls.MercadoPago`).
 *
 * Compilation-only test (molde `domain/entities/project.test.ts`): si el campo falta,
 * `ts-jest` no compila este archivo.
 */
import type { UpdateBalanceAndInvoicesParams } from '../../../domain/ports/ClientMirrorRepository';

describe('ClientMirrorRepository — UpdateBalanceAndInvoicesParams.paymentUrl (DAT-3)', () => {
  it('acepta paymentUrl junto con el saldo y las facturas', () => {
    const params: UpdateBalanceAndInvoicesParams = {
      grClienteId: 'gr-1',
      amount: 45000,
      currency: 'ARS',
      invoices: null,
      at: new Date('2026-09-04T00:00:00Z'),
      paymentUrl: 'https://mpago.example/pay/total',
    };

    expect(params.paymentUrl).toBe('https://mpago.example/pay/total');
  });

  it('paymentUrl es OPCIONAL — callers existentes (sin el campo) siguen compilando', () => {
    const params: UpdateBalanceAndInvoicesParams = {
      grClienteId: 'gr-1',
      amount: 45000,
      currency: 'ARS',
      invoices: null,
      at: new Date('2026-09-04T00:00:00Z'),
    };

    expect(params.paymentUrl).toBeUndefined();
  });

  it('paymentUrl acepta null explícito — vaciar el link a propósito (distinto de omitirlo)', () => {
    const params: UpdateBalanceAndInvoicesParams = {
      grClienteId: 'gr-1',
      amount: 45000,
      currency: 'ARS',
      invoices: null,
      at: new Date('2026-09-04T00:00:00Z'),
      paymentUrl: null,
    };

    expect(params.paymentUrl).toBeNull();
  });
});

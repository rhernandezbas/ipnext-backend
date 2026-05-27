import { parseClientBalanceResponse } from '@infrastructure/adapters/gestion-real/GestionRealClient';

// Real GR payload structure from Phase 0 recon
const REAL_DEBTOR_PAYLOAD = {
  error: '0',
  clientes: [
    {
      idcustomer: '100011',
      name: 'Cliente Ejemplo',
      cuentas: {
        debt: '65722.07',
        debt_uss: null,
        duedebt: '',
        noduedebt: '',
        invoices_qty: '2',
        invoices: [],
        payments_url_saldos: { MercadoPago: 'https://pagos.gestionreal.com.ar/mp/abc' },
      },
    },
  ],
};

const NO_DEBT_PAYLOAD = {
  error: '0',
  clientes: [
    {
      idcustomer: '100022',
      name: 'Cliente Sin Deuda',
      cuentas: {
        debt: '0',
        debt_uss: null,
        duedebt: '',
        noduedebt: '',
        invoices_qty: '0',
        invoices: [],
        payments_url_saldos: {},
      },
    },
  ],
};

const AR_FORMAT_PAYLOAD = {
  error: '0',
  clientes: [
    {
      idcustomer: '100033',
      cuentas: {
        debt: '1.234,56',
        invoices_qty: '1',
        invoices: [],
      },
    },
  ],
};

const MISSING_CUENTAS_PAYLOAD = {
  error: '0',
  clientes: [{ idcustomer: '100044' }],
};

const EMPTY_CLIENTES_PAYLOAD = {
  error: '0',
  clientes: [],
};

describe('parseClientBalanceResponse', () => {
  it('parses a real debtor payload with dot-decimal amount', () => {
    const result = parseClientBalanceResponse('100011', REAL_DEBTOR_PAYLOAD);
    expect(result.grClienteId).toBe('100011');
    expect(result.amount).toBe(65722.07);
    expect(result.currency).toBe('ARS');
    expect(result.invoicesQty).toBe(2);
  });

  it('extracts MercadoPago payment URL', () => {
    const result = parseClientBalanceResponse('100011', REAL_DEBTOR_PAYLOAD);
    expect(result.paymentUrls?.MercadoPago).toBe('https://pagos.gestionreal.com.ar/mp/abc');
  });

  it('returns amount=0 for a no-debt client', () => {
    const result = parseClientBalanceResponse('100022', NO_DEBT_PAYLOAD);
    expect(result.amount).toBe(0);
    expect(result.invoicesQty).toBe(0);
  });

  it('parses AR number format "1.234,56" -> 1234.56', () => {
    const result = parseClientBalanceResponse('100033', AR_FORMAT_PAYLOAD);
    expect(result.amount).toBe(1234.56);
  });

  it('returns amount=0 defensively when cuentas is missing', () => {
    const result = parseClientBalanceResponse('100044', MISSING_CUENTAS_PAYLOAD);
    expect(result.amount).toBe(0);
    expect(result.currency).toBeNull();
  });

  it('returns amount=0 defensively when clientes array is empty', () => {
    const result = parseClientBalanceResponse('100055', EMPTY_CLIENTES_PAYLOAD);
    expect(result.amount).toBe(0);
  });

  it('returns amount=0 defensively on null/garbage input', () => {
    const result = parseClientBalanceResponse('999', null);
    expect(result.amount).toBe(0);
  });

  it('treats empty string debt as 0', () => {
    const payload = {
      error: '0',
      clientes: [{ idcustomer: '100066', cuentas: { debt: '', invoices_qty: '0', invoices: [] } }],
    };
    const result = parseClientBalanceResponse('100066', payload);
    expect(result.amount).toBe(0);
  });
});

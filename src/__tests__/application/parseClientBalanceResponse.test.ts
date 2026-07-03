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

// Real GR invoice item shape captured live in Phase 0 (2026-07-03).
const REAL_INVOICE_ITEM = {
  tipo: 'FB',
  sucursal: '00010',
  numero: '000074035',
  moneda: 'PES',
  fecha: '26-06-2026',
  fecha_vto: '07-07-2026',
  importe: 35121.37,
  saldo: 35121.37,
  url_pdf: 'https://clientes.ipnext.com.ar/factura_prt.php?id=1',
  cupon_pdf: 'https://clientes.ipnext.com.ar/factura_prt.php?id=1&cupon=SI',
  payments_url: { MercadoPago: 'https://pagos.gestionreal.com.ar/mp.php?id=1' },
};

function payloadWithInvoices(invoices: unknown): unknown {
  return {
    error: '0',
    clientes: [
      {
        idcustomer: '100011',
        cuentas: { debt: '35121.37', invoices_qty: '1', invoices },
      },
    ],
  };
}

describe('parseClientBalanceResponse — invoices', () => {
  it('maps the real GR invoice item into GrClientBalance.invoices', () => {
    const result = parseClientBalanceResponse('100011', payloadWithInvoices([REAL_INVOICE_ITEM]));
    expect(result.invoices).toHaveLength(1);
    const inv = result.invoices[0];
    expect(inv.tipo).toBe('FB');
    expect(inv.sucursal).toBe('00010');
    expect(inv.numero).toBe('000074035');
    expect(inv.moneda).toBe('PES');
    expect(inv.fecha).toBe('26-06-2026');
    expect(inv.fechaVto).toBe('07-07-2026');
    expect(inv.importe).toBe(35121.37);
    expect(inv.saldo).toBe(35121.37);
    expect(inv.urlPdf).toBe('https://clientes.ipnext.com.ar/factura_prt.php?id=1');
    expect(inv.cuponPdf).toBe('https://clientes.ipnext.com.ar/factura_prt.php?id=1&cupon=SI');
    expect(inv.paymentUrl).toBe('https://pagos.gestionreal.com.ar/mp.php?id=1');
  });

  it('returns [] when invoices is an empty array', () => {
    const result = parseClientBalanceResponse('100011', payloadWithInvoices([]));
    expect(result.invoices).toEqual([]);
  });

  it('returns [] when invoices is absent', () => {
    const payload = { error: '0', clientes: [{ idcustomer: '100011', cuentas: { debt: '0' } }] };
    const result = parseClientBalanceResponse('100011', payload);
    expect(result.invoices).toEqual([]);
  });

  it('returns [] (no throw) when invoices is malformed (not an array)', () => {
    const result = parseClientBalanceResponse('100011', payloadWithInvoices('garbage'));
    expect(result.invoices).toEqual([]);
  });

  it('skips malformed items but keeps the well-formed ones', () => {
    const result = parseClientBalanceResponse('100011', payloadWithInvoices([REAL_INVOICE_ITEM, null, 42, {}]));
    // The {} item has no numero → skipped; null/42 skipped. Only the real one survives.
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].numero).toBe('000074035');
  });

  it('skips an item missing tipo or sucursal (composite id would degrade, review #6)', () => {
    const noTipo = { ...REAL_INVOICE_ITEM, numero: '000074099', tipo: undefined };
    const noSucursal = { ...REAL_INVOICE_ITEM, numero: '000074100', sucursal: undefined };
    const result = parseClientBalanceResponse(
      '100011',
      payloadWithInvoices([REAL_INVOICE_ITEM, noTipo, noSucursal]),
    );
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].numero).toBe('000074035');
  });

  it('handles a negative saldo (credit note) and missing payment url', () => {
    const creditNote = { ...REAL_INVOICE_ITEM, numero: '000074036', saldo: -500, payments_url: {} };
    const result = parseClientBalanceResponse('100011', payloadWithInvoices([creditNote]));
    expect(result.invoices[0].saldo).toBe(-500);
    expect(result.invoices[0].paymentUrl).toBeNull();
  });

  it('returns invoices [] on the defensive zero path', () => {
    const result = parseClientBalanceResponse('999', null);
    expect(result.invoices).toEqual([]);
  });
});

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

  // ===========================================================================
  // FIX-1 (CRITICAL) — "sin datos" NO es "no debe nada".
  //
  // Estos 4 tests ANTES pineaban el camino "defensivo" que devolvia amount=0.
  // Se INVIRTIERON con evidencia, no para que pase el codigo nuevo:
  //
  // El `zero` que devolvia este parser viajaba hasta `upsertInvoices`, que es
  // REPLACE-ALL. Cadena verificada en vivo contra prod el 2026-08-04:
  //   1. GR contesta HTTP 200 con sobre de error. REPRODUCIDO mandando el
  //      password diario de ayer (el incidente del MD5 con el contenedor en UTC):
  //        200 {"error":"90","descripcion":"No tiene Acceso"}   (sin nodo clientes)
  //      Y un cliente inexistente da 200 {"error":"2","status":"No se encontraron
  //      clientes"} — tambien sin nodo clientes.
  //   2. El parser lo degradaba a { amount: 0, invoices: [] } SIN tirar, asi que
  //      ningun catch lo atajaba.
  //   3. El guard `invoices.length > 0 || amount <= 0` lo dejaba pasar por `0 <= 0`.
  //   4. `deleteMany({ NOT: { grInvoiceId: { in: [] } } })` matchea TODO. Medido
  //      con el Prisma real del contenedor de prod: 6 facturas -> 6 matcheadas.
  //   => un blip de GR borraba las facturas de todos los clientes del batch, con
  //      `SyncState.lastResult = 'ok'` y el dashboard de Finanzas en VERDE.
  //
  // El hermano en el MISMO archivo (`parseReceiptsResponse`) ya tiraba ante un
  // `root.error` distinto de '0'. Esa asimetria era el descuido.
  //
  // Un throw es el comportamiento correcto: los dos callers
  // (RefreshDebtorBalances y RefreshClientBalanceIfStale) ya lo capturan y
  // sirven lo guardado. Fallar hacia "no toco nada" en vez de hacia "borro todo".
  // ===========================================================================

  it('FIX-1 — TIRA ante un sobre de error de GR (error 90, HTTP 200): no es deuda cero', () => {
    expect(() =>
      parseClientBalanceResponse('204366', { error: '90', descripcion: 'No tiene Acceso' }),
    ).toThrow(/90/);
  });

  it('FIX-1 — TIRA ante "No se encontraron clientes" (error 2)', () => {
    expect(() =>
      parseClientBalanceResponse('99999999', { error: '2', status: 'No se encontraron clientes' }),
    ).toThrow('error 2: No se encontraron clientes');
  });

  it('FIX-1 — TIRA cuando falta el nodo cuentas (medido: 32/32 clientes reales lo traen)', () => {
    expect(() => parseClientBalanceResponse('100044', MISSING_CUENTAS_PAYLOAD)).toThrow(
      /no trae el nodo cuentas/,
    );
  });

  it('FIX-1 — TIRA cuando el array clientes viene vacio', () => {
    expect(() => parseClientBalanceResponse('100055', EMPTY_CLIENTES_PAYLOAD)).toThrow(
      /no trae el cliente/,
    );
  });

  it('FIX-1 — TIRA ante input null/basura', () => {
    expect(() => parseClientBalanceResponse('999', null)).toThrow(/no interpretable/);
    expect(() => parseClientBalanceResponse('999', 'no soy json')).toThrow(/no interpretable/);
    // Un objeto sin `error` ni `clientes` no es "deuda cero": es una respuesta que
    // no entendemos.
    expect(() => parseClientBalanceResponse('999', { cualquier: 'cosa' })).toThrow(
      /no trae el cliente/,
    );
  });

  it('FIX-1 — pero NO tira con deuda 0 LEGITIMA: ese borrado tiene que seguir funcionando', () => {
    // Medido en vivo: de 32 clientes reales muestreados, 12 tienen deuda 0.
    // Si esto tirara, romperiamos el caso "pago todo" — que es JUSTO el que este
    // change vino a arreglar.
    const result = parseClientBalanceResponse('100022', NO_DEBT_PAYLOAD);
    expect(result.amount).toBe(0);
    expect(result.invoices).toEqual([]);
  });

  // ===========================================================================
  // FIX-1b — el hermano que FIX-1 dejo vivo: guardaba el CONTENEDOR, no el VALOR.
  //
  // FIX-1 tiraba si faltaba el nodo `cuentas`, pero si `cuentas` estaba presente
  // y `debt` venia null / '' / no-numerico, `str()` daba null y `parseArNumber`
  // lo convertia en **0** => "no debe nada" => el mismo borrado masivo, con el
  // fix puesto.
  //
  // Y la evidencia estaba en el fixture de ESTE archivo: `REAL_DEBTOR_PAYLOAD`
  // tiene, en el MISMO nodo `cuentas`, `debt_uss: null`, `duedebt: ''` y
  // `noduedebt: ''`. Medido contra GR en vivo sobre 36 clientes reales:
  //   cuentas.debt -> string en 36/36
  //   debt_uss     -> null  en 36/36
  //   duedebt      -> ''    en 36/36
  //   noduedebt    -> ''    en 36/36
  // O sea que GR manda null y '' en campos de plata de ese nodo de forma
  // UNIVERSAL. Que `debt` nunca lo haga es una premisa NO VERIFICADA — la misma
  // clase de premisa que causo el bug original.
  //
  // El test anterior se llamaba `treats empty string debt as 0` y CERTIFICABA
  // este camino como correcto: era el candado del bug.
  // ===========================================================================

  it('FIX-1b — `debt: ""` NO es cero: es SIN DATO, y tira', () => {
    const payload = {
      error: '0',
      clientes: [{ idcustomer: '100066', cuentas: { debt: '', invoices_qty: '0', invoices: [] } }],
    };
    expect(() => parseClientBalanceResponse('100066', payload)).toThrow(/ausente o vacio/);
  });

  it('FIX-1b — `debt: null` tira (GR ya manda null en los hermanos del mismo nodo)', () => {
    const payload = {
      error: '0',
      clientes: [{ idcustomer: '100066', cuentas: { debt: null, invoices_qty: '0', invoices: [] } }],
    };
    expect(() => parseClientBalanceResponse('100066', payload)).toThrow(/ausente o vacio/);
  });

  it('FIX-1b — `debt` AUSENTE tira', () => {
    const payload = {
      error: '0',
      clientes: [{ idcustomer: '100066', cuentas: { invoices_qty: '0', invoices: [] } }],
    };
    expect(() => parseClientBalanceResponse('100066', payload)).toThrow(/ausente o vacio/);
  });

  it('FIX-1b — `debt` NO NUMERICO tira en vez de degradarse a 0', () => {
    // parseArNumber devuelve 0 ante basura (isFinite false => 0). Ese 0 rio abajo
    // es la afirmacion "no debe nada" y borra las facturas.
    const payload = {
      error: '0',
      clientes: [{ idcustomer: '100066', cuentas: { debt: 'N/D', invoices_qty: '0', invoices: [] } }],
    };
    expect(() => parseClientBalanceResponse('100066', payload)).toThrow(/no numerico/);
  });

  it('FIX-1b — `cuentas` truthy pero NO objeto tira (era un chequeo de truthiness)', () => {
    // `if (!cuentas)` dejaba pasar cualquier cosa truthy: `cuentas: "sin datos"`
    // => cuentas.debt undefined => 0 => borra todo.
    const payload = {
      error: '0',
      clientes: [{ idcustomer: '100066', cuentas: 'sin datos' }],
    };
    expect(() => parseClientBalanceResponse('100066', payload)).toThrow(/no trae el nodo cuentas/);
  });

  // ---------------------------------------------------------------------------
  // FIX-1c — el hermano que FIX-1b dejo vivo: el gate era `n === 0`, pero el
  // gatillo destructivo rio abajo es `amount <= 0`. Cualquier basura con un menos
  // adelante se salteaba la validacion ENTERA y caia justo en el replace-all:
  //   "-500 nota de credito" -> parseFloat lee -500 -> n !== 0 -> sin validar
  //                          -> amount <= 0 -> BORRA TODO
  // mientras que la MISMA basura con un 0 adelante ("0abc") si tiraba.
  // ---------------------------------------------------------------------------

  it('FIX-1c — basura NEGATIVA tira (el gate `n === 0` la dejaba pasar al borrado)', () => {
    for (const basura of ['-500 nota de credito', '-1abc', '-0.5 xx', '-']) {
      const payload = {
        error: '0',
        clientes: [{ idcustomer: '100066', cuentas: { debt: basura, invoices_qty: '0', invoices: [] } }],
      };
      expect(() => parseClientBalanceResponse('100066', payload)).toThrow(/no numerico/);
    }
  });

  it('FIX-1c — un credito LEGITIMO (saldo a favor) sigue pasando', () => {
    const payload = {
      error: '0',
      clientes: [{ idcustomer: '100066', cuentas: { debt: '-1500.50', invoices_qty: '0', invoices: [] } }],
    };
    expect(parseClientBalanceResponse('100066', payload).amount).toBe(-1500.5);
  });

  it('FIX-1c — formato de miles AMBIGUO tira en vez de adivinar', () => {
    // "1.234" puede ser 1,234 (decimal plano) o 1234 (miles AR). No hay forma de
    // saberlo, y `parseArNumber` lo lee como 1.234 — un error de MIL VECES sobre
    // plata. Ante ambiguedad de plata no se adivina: se falla hacia "no toco nada".
    for (const ambiguo of ['1.234', '12.345', '1.000']) {
      const payload = {
        error: '0',
        clientes: [{ idcustomer: '100066', cuentas: { debt: ambiguo, invoices_qty: '0', invoices: [] } }],
      };
      expect(() => parseClientBalanceResponse('100066', payload)).toThrow(/ambiguo|no numerico/);
    }
  });

  it('FIX-1c — "0.000" NO es ambiguo: las dos lecturas dan cero, y pasa', () => {
    // Rechazarlo seria un falso negativo que deja al cliente sin refrescar nunca
    // — el bug original por otra puerta.
    const payload = {
      error: '0',
      clientes: [{ idcustomer: '100066', cuentas: { debt: '0.000', invoices_qty: '0', invoices: [] } }],
    };
    expect(parseClientBalanceResponse('100066', payload).amount).toBe(0);
  });

  it('FIX-1c — pero el formato AR con coma NO es ambiguo y pasa bien', () => {
    const payload = {
      error: '0',
      clientes: [{ idcustomer: '100066', cuentas: { debt: '1.234,56', invoices_qty: '0', invoices: [] } }],
    };
    expect(parseClientBalanceResponse('100066', payload).amount).toBe(1234.56);
  });

  it('FIX-1c — el locale EN ("1,234.56") tira: se leia como 1.23456 en silencio', () => {
    const payload = {
      error: '0',
      clientes: [{ idcustomer: '100066', cuentas: { debt: '1,234.56', invoices_qty: '0', invoices: [] } }],
    };
    expect(() => parseClientBalanceResponse('100066', payload)).toThrow(/no numerico/);
  });

  it('FIX-1b — pero `debt: "0.00"` (el formato REAL de GR) sigue siendo deuda cero valida', () => {
    // Medido en vivo: los 36 clientes traen debt como string; el que no debe nada
    // trae "0.00". Ese camino DEBE seguir permitiendo el borrado legitimo.
    const payload = {
      error: '0',
      clientes: [{ idcustomer: '100066', cuentas: { debt: '0.00', invoices_qty: '0', invoices: [] } }],
    };
    const result = parseClientBalanceResponse('100066', payload);
    expect(result.amount).toBe(0);
    expect(result.invoices).toEqual([]);
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

  it('FIX-1 — el camino "zero defensivo" ya no existe: input basura TIRA', () => {
    expect(() => parseClientBalanceResponse('999', null)).toThrow(/no interpretable/);
  });
});

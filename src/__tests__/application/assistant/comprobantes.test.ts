import {
  detectDoublePayment,
  detectPaymentPromise,
  extractComprobanteOperacion,
  matchReceiptOperation,
  type ReceiptFact,
} from '@application/use-cases/assistant/comprobantes';

/**
 * ai-assistant-cobranzas (3.5/3.6 / D9/D11 / DAT-4/INT-2) — funciones puras del selector de
 * comprobantes. Casos reales del 04-09: Vargas (op 177332834792), Bravo Eduardo (doble pago
 * $77.997,19).
 */

function receipt(overrides: Partial<ReceiptFact> = {}): ReceiptFact {
  return {
    hora: '10:15',
    recaudador: 'mercadopago',
    importe: 77997.19,
    referencias: ['MercadoPago: 177332834792'],
    ...overrides,
  };
}

describe('extractComprobanteOperacion', () => {
  it('DAT-4: extrae el número de operación de comprobante_<op>.pdf', () => {
    expect(extractComprobanteOperacion(['comprobante_177332834792.pdf'])).toBe('177332834792');
  });

  it('acepta .jpg, .jpeg y .png', () => {
    expect(extractComprobanteOperacion(['comprobante_123456.jpg'])).toBe('123456');
    expect(extractComprobanteOperacion(['comprobante_123456.jpeg'])).toBe('123456');
    expect(extractComprobanteOperacion(['comprobante_123456.png'])).toBe('123456');
  });

  it('menos de 6 dígitos ⇒ null', () => {
    expect(extractComprobanteOperacion(['comprobante_12345.pdf'])).toBeNull();
  });

  it('otro archivo (no comprobante_*) ⇒ null', () => {
    expect(extractComprobanteOperacion(['factura_123456789.pdf'])).toBeNull();
  });

  it('sin adjuntos ⇒ null', () => {
    expect(extractComprobanteOperacion([])).toBeNull();
  });

  it('varios adjuntos ⇒ el primero que matchea', () => {
    expect(
      extractComprobanteOperacion(['foto.jpg', 'comprobante_555666777.pdf', 'otro.png']),
    ).toBe('555666777');
  });

  it('extensión no soportada (.docx) ⇒ null', () => {
    expect(extractComprobanteOperacion(['comprobante_123456789.docx'])).toBeNull();
  });
});

describe('matchReceiptOperation', () => {
  it('DAT-4: matchea si una referencia CONTIENE la operación', () => {
    const result = matchReceiptOperation('177332834792', [receipt()]);

    expect(result).toMatchObject({ encontrado: true, importe: 77997.19 });
  });

  it('sin match, encontrado:false', () => {
    const result = matchReceiptOperation('000000000000', [receipt()]);

    expect(result.encontrado).toBe(false);
  });

  it('NO matchea por prefijo corto: un op de menos de 6 dígitos nunca matchea, aunque SEA prefijo literal de una referencia', () => {
    // "1773" es literalmente un prefijo/substring de "177332834792", pero un op tan corto es
    // basura (mismo piso que extractComprobanteOperacion): matchear por 4 dígitos daría falsos
    // positivos contra cualquier recibo cuya referencia los contenga por casualidad.
    const result = matchReceiptOperation('1773', [receipt({ referencias: ['MercadoPago: 177332834792'] })]);

    expect(result.encontrado).toBe(false);
  });

  it('con lista vacía de recibos, no matchea', () => {
    const result = matchReceiptOperation('177332834792', []);

    expect(result.encontrado).toBe(false);
  });

  it('operacion null cuando no hay match', () => {
    const result = matchReceiptOperation(null, [receipt()]);

    expect(result).toEqual({ operacion: null, encontrado: false });
  });
});

describe('detectDoublePayment', () => {
  it('DAT-4/R5: 2 recibos de $77.997,19 (caso Bravo) ⇒ true', () => {
    const recibos = [
      receipt({ hora: '10:15', importe: 77997.19 }),
      receipt({ hora: '10:17', importe: 77997.19 }),
    ];

    expect(detectDoublePayment(recibos)).toBe(true);
  });

  it('importes distintos ⇒ false', () => {
    const recibos = [receipt({ importe: 77997.19 }), receipt({ importe: 41410.56 })];

    expect(detectDoublePayment(recibos)).toBe(false);
  });

  it('un solo recibo ⇒ false', () => {
    expect(detectDoublePayment([receipt()])).toBe(false);
  });

  it('sin recibos ⇒ false', () => {
    expect(detectDoublePayment([])).toBe(false);
  });

  it('comparación en centavos, sin errores de float (0.1 + 0.2 !== 0.3)', () => {
    const recibos = [receipt({ importe: 100.1 }), receipt({ importe: 100.1 })];

    expect(detectDoublePayment(recibos)).toBe(true);
  });

  it('3 recibos, sólo 2 coinciden ⇒ true igual', () => {
    const recibos = [
      receipt({ importe: 1000 }),
      receipt({ importe: 1000 }),
      receipt({ importe: 500 }),
    ];

    expect(detectDoublePayment(recibos)).toBe(true);
  });
});

describe('detectPaymentPromise', () => {
  const patterns = [
    'te pago el lunes',
    'a fin de mes',
    'cuando cobre',
    'no puedo ahora',
  ];

  it('INT-2: "te pago el lunes" ⇒ true', () => {
    expect(detectPaymentPromise('uy disculpá, te pago el lunes sin falta', patterns)).toBe(true);
  });

  it('"a fin de mes" ⇒ true', () => {
    expect(detectPaymentPromise('te lo salgo a fin de mes', patterns)).toBe(true);
  });

  it('"cuando cobre" ⇒ true', () => {
    expect(detectPaymentPromise('apenas cuando cobre te transfiero', patterns)).toBe(true);
  });

  it('"no puedo ahora" ⇒ true', () => {
    expect(detectPaymentPromise('no puedo ahora, la semana que viene sí', patterns)).toBe(true);
  });

  it('"ya te pagué" ⇒ false', () => {
    expect(detectPaymentPromise('ya te pagué, revisá de nuevo', patterns)).toBe(false);
  });

  it('regex inválida se ignora con warn, no rompe', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = detectPaymentPromise('te pago el lunes', ['([', ...patterns]);

    expect(result).toBe(true);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('lista de patterns vacía ⇒ false', () => {
    expect(detectPaymentPromise('te pago el lunes', [])).toBe(false);
  });
});

import { sumarItemsPorMoneda } from '@domain/services/sumarItemsPorMoneda';

describe('sumarItemsPorMoneda — PAY-1.3 / PAY-1.4', () => {
  it('un item ⇒ un total en su moneda, normalizada a ISO', () => {
    // `PES` es el codigo de GR, no ISO 4217. Medido en el payload real del pago
    // del usuario: { importe: "2500.01", moneda: "PES" }.
    expect(sumarItemsPorMoneda([{ amount: 2500.01, moneda: 'PES' }])).toEqual([
      { currency: 'ARS', amount: 2500.01 },
    ]);
  });

  it('dos items de la MISMA moneda se suman', () => {
    expect(
      sumarItemsPorMoneda([
        { amount: 1000, moneda: 'PES' },
        { amount: 500.5, moneda: 'PES' },
      ]),
    ).toEqual([{ currency: 'ARS', amount: 1500.5 }]);
  });

  it('PAY-1.4 — monedas DISTINTAS no se suman: salen separadas', () => {
    // Sumar pesos con dolares da un numero sin sentido economico. Es la misma
    // regla que obligo a `balances[]` por moneda en /me.
    const out = sumarItemsPorMoneda([
      { amount: 1000, moneda: 'PES' },
      { amount: 12, moneda: 'DOL' },
    ]);
    expect(out).toHaveLength(2);
    expect(out).toEqual(expect.arrayContaining([
      { currency: 'ARS', amount: 1000 },
      { currency: 'USD', amount: 12 },
    ]));
  });

  it('ordena por importe DESC para que la moneda principal quede primera', () => {
    const out = sumarItemsPorMoneda([
      { amount: 12, moneda: 'DOL' },
      { amount: 1000, moneda: 'PES' },
    ]);
    expect(out[0].currency).toBe('ARS');
  });

  it('moneda ausente ⇒ DESCONOCIDA, y NO se fusiona con una conocida', () => {
    // Fusionarla con la conocida seria asumir un tipo de cambio implicito.
    const out = sumarItemsPorMoneda([
      { amount: 1000, moneda: 'PES' },
      { amount: 50, moneda: null },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.currency).sort()).toEqual(['ARS', 'DESCONOCIDA']);
  });

  it('sin items ⇒ lista vacia (no un cero inventado)', () => {
    expect(sumarItemsPorMoneda([])).toEqual([]);
  });

  it('redondea a 2 decimales: la suma de Decimals no arrastra error binario', () => {
    // 0.1 + 0.2 = 0.30000000000000004 en JS. Sobre plata, eso no se muestra.
    expect(sumarItemsPorMoneda([
      { amount: 0.1, moneda: 'PES' },
      { amount: 0.2, moneda: 'PES' },
    ])).toEqual([{ currency: 'ARS', amount: 0.3 }]);
  });
});

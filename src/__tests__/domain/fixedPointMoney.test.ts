/**
 * twilio-credit-guard (D2) — fixedPointMoney. Módulo PURO, molde
 * `bulkRecipientAuthorization.ts` (servicio de dominio sin dependencias).
 * Punto fijo de 4 decimales (1/10000), CERO Number flotante en el camino de
 * decisión de plata. Pinea: half-up al 5º dígito, round-trip, rechazo de
 * inputs no confiables (`tryParseMoney` degrada a null, `parseMoney` tira).
 */
import {
  parseMoney,
  tryParseMoney,
  addMoney,
  multiplyMoneyByCount,
  compareMoney,
  formatMoney,
  MoneyParseError,
  MONEY_SCALE,
} from '@domain/services/fixedPointMoney';

describe('fixedPointMoney — parseMoney', () => {
  it("'17.894' → 178940 (3 decimales del body REAL de Twilio, D0 hecho verificado)", () => {
    expect(parseMoney('17.894')).toBe(178940);
  });

  it("'0.0618' × 500 = '30.9000' EXACTO (COST-3, sin arrastre de punto flotante)", () => {
    const unit = parseMoney('0.0618');
    const total = multiplyMoneyByCount(unit, 500);
    expect(formatMoney(total)).toBe('30.9000');
  });

  it("half-up: '0.00005' → 1 (redondea hacia arriba en el borde)", () => {
    expect(parseMoney('0.00005')).toBe(1);
  });

  it("half-up: '0.00004' → 0 (no redondea hacia arriba por debajo del borde)", () => {
    expect(parseMoney('0.00004')).toBe(0);
  });

  it("negativos: '-3' → -30000", () => {
    expect(parseMoney('-3')).toBe(-30000);
  });

  it('MONEY_SCALE es 10000 (1/10000 de unidad)', () => {
    expect(MONEY_SCALE).toBe(10_000);
  });

  it.each(['', '1e3', 'NaN', '1,5', 'Infinity'])(
    'parseMoney tira MoneyParseError para %j (input no confiable)',
    (input) => {
      expect(() => parseMoney(input)).toThrow(MoneyParseError);
    },
  );

  it('parseMoney tira MoneyParseError para null (cast a string primero)', () => {
    expect(() => parseMoney(null as unknown as string)).toThrow(MoneyParseError);
  });
});

describe('fixedPointMoney — tryParseMoney (degrada a null, nunca tira)', () => {
  it.each(['', '1e3', 'NaN', '1,5', 'Infinity'])(
    'tryParseMoney(%j) → null',
    (input) => {
      expect(tryParseMoney(input)).toBeNull();
    },
  );

  it('tryParseMoney(null) → null', () => {
    expect(tryParseMoney(null)).toBeNull();
  });

  it('tryParseMoney(undefined) → null', () => {
    expect(tryParseMoney(undefined)).toBeNull();
  });

  it("tryParseMoney('17.894') → 178940 (camino feliz, igual que parseMoney)", () => {
    expect(tryParseMoney('17.894')).toBe(178940);
  });

  it('tryParseMoney acepta un number de entrada convirtiéndolo con String(n) primero', () => {
    expect(tryParseMoney(17.894)).toBe(178940);
  });
});

describe('fixedPointMoney — formatMoney', () => {
  it('178940 → "17.8940" — SIEMPRE 4 decimales', () => {
    expect(formatMoney(178940)).toBe('17.8940');
  });

  it('0 → "0.0000"', () => {
    expect(formatMoney(0)).toBe('0.0000');
  });

  it('-30000 → "-3.0000"', () => {
    expect(formatMoney(-30000)).toBe('-3.0000');
  });

  it.each(['17.8940', '0.0170', '8.5000', '0.0000', '30.9000'])(
    'round-trip: formatMoney(parseMoney(%j)) === %j para valores de 4 decimales',
    (value) => {
      expect(formatMoney(parseMoney(value))).toBe(value);
    },
  );
});

describe('fixedPointMoney — addMoney / compareMoney', () => {
  it('addMoney suma enteros de punto fijo', () => {
    expect(addMoney(parseMoney('0.0120'), parseMoney('0.0050'))).toBe(parseMoney('0.0170'));
  });

  it('compareMoney: a < b → -1', () => {
    expect(compareMoney(parseMoney('1.0000'), parseMoney('2.0000'))).toBe(-1);
  });

  it('compareMoney: a === b → 0 (borde exacto, COST-4 "límite exacto")', () => {
    expect(compareMoney(parseMoney('8.50'), parseMoney('8.5000'))).toBe(0);
  });

  it('compareMoney: a > b → 1', () => {
    expect(compareMoney(parseMoney('3.0000'), parseMoney('2.0000'))).toBe(1);
  });
});

describe('fixedPointMoney — multiplyMoneyByCount', () => {
  it('count no entero tira', () => {
    expect(() => multiplyMoneyByCount(parseMoney('1.0000'), 2.5)).toThrow();
  });

  it('count negativo tira', () => {
    expect(() => multiplyMoneyByCount(parseMoney('1.0000'), -1)).toThrow();
  });

  it('count === 0 → 0 (borde válido, no tira)', () => {
    expect(multiplyMoneyByCount(parseMoney('1.0000'), 0)).toBe(0);
  });

  it('lote de 500 sin arrastre de punto flotante: unitCost 0.0170 → estimatedCost 8.5000 (COST-3)', () => {
    const unit = parseMoney('0.0170');
    const total = multiplyMoneyByCount(unit, 500);
    expect(formatMoney(total)).toBe('8.5000');
  });
});

describe('fixedPointMoney — Number.isSafeInteger al salir', () => {
  it('un monto absurdamente grande tira en vez de devolver un entero no seguro', () => {
    expect(() => parseMoney('99999999999999999999999.9999')).toThrow(MoneyParseError);
  });
});

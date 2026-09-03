/**
 * twilio-credit-guard (Batch 2, task 2.1, D4.a) — `estimateMessagingCost`.
 * Matriz spec↔test: COST-1..4 de
 * `openspec/changes/twilio-credit-guard/specs/messaging-credit-guard/spec.md`.
 *
 * Módulo PURO — sin adapters, sin I/O. `rates`/`balance` se arman a mano en
 * cada test (molde `externalBulkPayloadHash.test.ts`).
 */
import { estimateMessagingCost } from '@application/use-cases/messaging/EstimateMessagingCost';
import { MESSAGING_RATES_CONFIG_DEFAULTS, MessagingRatesConfig } from '@domain/ports/MessagingRatesConfigRepository';
import { CreditBalance } from '@domain/ports/CreditBalancePort';

const NOW = new Date('2026-09-03T12:00:00.000Z');

function makeRates(overrides: Partial<MessagingRatesConfig> = {}): MessagingRatesConfig {
  return { ...MESSAGING_RATES_CONFIG_DEFAULTS, updatedAt: NOW.toISOString(), ...overrides };
}

function makeBalance(overrides: Partial<CreditBalance> = {}): CreditBalance {
  return { amount: '17.8940', currency: 'USD', fetchedAt: NOW, cached: false, ...overrides };
}

describe('estimateMessagingCost (COST-1..4)', () => {
  describe('COST-1 — unitCost = tarifa de categoría + providerFee', () => {
    it('UTILITY con defaults → unitCost 0.0170', () => {
      const result = estimateMessagingCost({
        category: 'UTILITY',
        validCount: 1,
        rates: makeRates(),
        balance: makeBalance(),
      });

      expect(result.unitCost).toBe('0.0170');
      expect(result.category).toBe('UTILITY');
      expect(result.categoryAssumed).toBeUndefined();
    });

    it('MARKETING con defaults → unitCost 0.0668', () => {
      const result = estimateMessagingCost({
        category: 'MARKETING',
        validCount: 1,
        rates: makeRates(),
        balance: makeBalance(),
      });

      expect(result.unitCost).toBe('0.0668');
      expect(result.category).toBe('MARKETING');
    });

    it('AUTHENTICATION con defaults → unitCost 0.0270', () => {
      const result = estimateMessagingCost({
        category: 'AUTHENTICATION',
        validCount: 1,
        rates: makeRates(),
        balance: makeBalance(),
      });

      expect(result.unitCost).toBe('0.0270');
      expect(result.category).toBe('AUTHENTICATION');
    });
  });

  describe('COST-2 — categoría ausente/desconocida ⇒ MARKETING + categoryAssumed', () => {
    it('category undefined ⇒ tarifa MARKETING + categoryAssumed:true', () => {
      const result = estimateMessagingCost({
        category: undefined,
        validCount: 1,
        rates: makeRates(),
        balance: makeBalance(),
      });

      expect(result.category).toBe('MARKETING');
      expect(result.unitCost).toBe('0.0668');
      expect(result.categoryAssumed).toBe(true);
    });

    it('category desconocida ("promocional") ⇒ tarifa MARKETING + categoryAssumed:true', () => {
      const result = estimateMessagingCost({
        category: 'promocional',
        validCount: 1,
        rates: makeRates(),
        balance: makeBalance(),
      });

      expect(result.category).toBe('MARKETING');
      expect(result.categoryAssumed).toBe(true);
    });
  });

  describe('COST-3 — estimatedCost en punto fijo, sin arrastre de float', () => {
    it('lote de 500, UTILITY defaults → estimatedCost 8.5000 EXACTO y determinístico', () => {
      const result = estimateMessagingCost({
        category: 'UTILITY',
        validCount: 500,
        rates: makeRates(),
        balance: null,
      });

      expect(result.unitCost).toBe('0.0170');
      expect(result.estimatedCost).toBe('8.5000');
    });
  });

  describe('COST-4 — suficiencia y mismatch de moneda', () => {
    it('balance:null ⇒ unknown:true, available:null, sufficient:false', () => {
      const result = estimateMessagingCost({
        category: 'UTILITY',
        validCount: 1,
        rates: makeRates(),
        balance: null,
      });

      expect(result.unknown).toBe(true);
      expect(result.available).toBeNull();
      expect(result.sufficient).toBe(false);
    });

    it('moneda del balance ≠ la de rates ⇒ unknown:true, NUNCA comparación a ciegas', () => {
      const result = estimateMessagingCost({
        category: 'UTILITY',
        validCount: 1,
        rates: makeRates({ currency: 'USD' }),
        balance: makeBalance({ currency: 'ARS', amount: '999999.0000' }),
      });

      expect(result.unknown).toBe(true);
      expect(result.available).toBeNull();
      expect(result.sufficient).toBe(false);
    });

    it('tarifa ilegible en la fila (tryParseMoney da null) ⇒ unknown:true, NUNCA tratada como 0', () => {
      const result = estimateMessagingCost({
        category: 'UTILITY',
        validCount: 1,
        rates: makeRates({ utilityRate: 'not-a-number' }),
        balance: makeBalance({ amount: '999999.0000' }),
      });

      expect(result.unknown).toBe(true);
      expect(result.sufficient).toBe(false);
      // NUNCA "sufficient:true" por haber tratado la tarifa ilegible como 0
      // contra un balance gigante — el fail-safe cierra el guard.
    });

    it('límite exacto: estimatedCost === available ⇒ sufficient:true (>=)', () => {
      const result = estimateMessagingCost({
        category: 'UTILITY',
        validCount: 500,
        rates: makeRates(),
        balance: makeBalance({ amount: '8.5000', currency: 'USD' }),
      });

      expect(result.estimatedCost).toBe('8.5000');
      expect(result.available).toBe('8.5000');
      expect(result.sufficient).toBe(true);
      expect(result.unknown).toBeUndefined();
    });

    it('estimatedCost > available ⇒ sufficient:false, sin unknown', () => {
      const result = estimateMessagingCost({
        category: 'UTILITY',
        validCount: 500,
        rates: makeRates(),
        balance: makeBalance({ amount: '8.4999', currency: 'USD' }),
      });

      expect(result.sufficient).toBe(false);
      expect(result.unknown).toBeUndefined();
      expect(result.available).toBe('8.4999');
    });
  });
});

/**
 * fix wave F1 (F8) — cuando `unknown:true`, `unitCost`/`estimatedCost` NO
 * pueden decir '0.0000'. Un cero es un NÚMERO, y quien lo lee (la card FE, la
 * IA que consume la API externa) razona con él: "gratis". La verdad es "no sé".
 */
describe('estimateMessagingCost — unknown ⇒ unitCost/estimatedCost null (fix wave F1, F8)', () => {
  it('tarifa ilegible ⇒ unitCost:null y estimatedCost:null (NO "0.0000")', () => {
    const result = estimateMessagingCost({
      category: 'UTILITY',
      validCount: 300,
      rates: makeRates({ utilityRate: 'not-a-number' }),
      balance: makeBalance({ amount: '999999.0000' }),
    });

    expect(result.unknown).toBe(true);
    expect(result.unitCost).toBeNull();
    expect(result.estimatedCost).toBeNull();
  });

  it('providerFee ilegible ⇒ unitCost:null y estimatedCost:null', () => {
    const result = estimateMessagingCost({
      category: 'UTILITY',
      validCount: 3,
      rates: makeRates({ providerFee: '' }),
      balance: makeBalance(),
    });

    expect(result.unknown).toBe(true);
    expect(result.unitCost).toBeNull();
    expect(result.estimatedCost).toBeNull();
  });

  it('balance:null ⇒ unknown, pero unitCost/estimatedCost SIGUEN siendo números (la tarifa SÍ se pudo leer)', () => {
    const result = estimateMessagingCost({
      category: 'UTILITY',
      validCount: 500,
      rates: makeRates(),
      balance: null,
    });

    expect(result.unknown).toBe(true);
    expect(result.unitCost).toBe('0.0170');
    expect(result.estimatedCost).toBe('8.5000');
    expect(result.available).toBeNull();
  });
});

/**
 * fix wave F1 (F4) — `rates:null` (el repo de tarifas REVENTÓ). Antes el
 * llamador inventaba los defaults; adivinar una tarifa para decidir si se
 * gasta plata real es exactamente lo que D4.c prohíbe.
 */
describe('estimateMessagingCost — rates:null ⇒ unknown, sin adivinar defaults (fix wave F1, F4)', () => {
  it('rates:null con un balance GIGANTE ⇒ unknown:true, sufficient:false, unitCost/estimatedCost null', () => {
    const result = estimateMessagingCost({
      category: 'UTILITY',
      validCount: 1,
      rates: null,
      balance: makeBalance({ amount: '999999.0000' }),
    });

    expect(result.unknown).toBe(true);
    expect(result.sufficient).toBe(false);
    expect(result.unitCost).toBeNull();
    expect(result.estimatedCost).toBeNull();
    expect(result.available).toBeNull();
  });

  it('rates:null NO tira y sigue reportando la categoría normalizada', () => {
    const result = estimateMessagingCost({
      category: undefined,
      validCount: 7,
      rates: null,
      balance: null,
    });

    expect(result.category).toBe('MARKETING');
    expect(result.categoryAssumed).toBe(true);
    expect(result.unknown).toBe(true);
  });
});

/**
 * fix wave F1 (F6) — `multiplyMoneyByCount` tira `MoneyParseError` en overflow.
 * El módulo se documenta como "nunca tira": una tarifa monstruosa escrita por
 * SQL a mano NO puede convertirse en un 500.
 */
describe('estimateMessagingCost — overflow de punto fijo ⇒ unknown, nunca throw (fix wave F1, F6)', () => {
  it('tarifa 900000000000.0000 × 2 destinatarios (overflow de safe integer) ⇒ unknown:true, sin excepción', () => {
    let result!: ReturnType<typeof estimateMessagingCost>;

    expect(() => {
      result = estimateMessagingCost({
        category: 'MARKETING',
        validCount: 2,
        rates: makeRates({ marketingRate: '900000000000.0000', providerFee: '0.0000' }),
        balance: makeBalance({ amount: '999999.0000' }),
      });
    }).not.toThrow();

    expect(result.unknown).toBe(true);
    expect(result.sufficient).toBe(false);
    expect(result.estimatedCost).toBeNull();
  });
});

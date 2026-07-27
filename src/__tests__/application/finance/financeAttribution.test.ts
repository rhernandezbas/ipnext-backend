import {
  attributeCollectedAmountToContracts,
  netCollectedAmountForMonth,
} from '@application/use-cases/finance/financeAttribution';
import type { FinanceInvoiceTypeBucket } from '@domain/ports/FinanceInvoiceTypeClassificationRepository';

describe('attributeCollectedAmountToContracts (design.md Decision 1, Capa B)', () => {
  // 3.4
  it('single-contract client — the whole collected amount goes to the one contract, exact confidence', () => {
    const shares = attributeCollectedAmountToContracts(150000, [{ contractId: 'c1', planCode: 'IP-30' }], new Map());
    expect(shares).toEqual([{ contractId: 'c1', amountArs: 150000, attributionConfidence: 'exact' }]);
  });

  // 3.5
  it('multi-contract, both plans priced — proportional split, estimated confidence, no centavos lost', () => {
    const planPrices = new Map([
      ['IP-30', 10000],
      ['IP-100', 30000],
    ]);
    const shares = attributeCollectedAmountToContracts(
      100000.01,
      [
        { contractId: 'c1', planCode: 'IP-30' },
        { contractId: 'c2', planCode: 'IP-100' },
      ],
      planPrices,
    );
    expect(shares.every((s) => s.attributionConfidence === 'estimated')).toBe(true);
    const c1 = shares.find((s) => s.contractId === 'c1')!;
    const c2 = shares.find((s) => s.contractId === 'c2')!;
    // 1/4 vs 3/4 of the total, rounded to the cent
    expect(c1.amountArs).toBeCloseTo(25000, 2);
    expect(c2.amountArs).toBeCloseTo(75000.01, 2);
    // invariant: the split reconciles EXACTLY to the input, no centavos silently dropped/created
    const sum = Math.round((c1.amountArs + c2.amountArs) * 100) / 100;
    expect(sum).toBe(100000.01);
  });

  // 3.6
  it('multi-contract, neither plan priced — equal split, estimated-equal confidence', () => {
    const shares = attributeCollectedAmountToContracts(
      90000,
      [
        { contractId: 'c1', planCode: 'IP-UNPRICED-A' },
        { contractId: 'c2', planCode: 'IP-UNPRICED-B' },
      ],
      new Map(),
    );
    expect(shares).toEqual(
      expect.arrayContaining([
        { contractId: 'c1', amountArs: 45000, attributionConfidence: 'estimated-equal' },
        { contractId: 'c2', amountArs: 45000, attributionConfidence: 'estimated-equal' },
      ]),
    );
  });

  // 3.7
  it('multi-contract, only ONE plan priced — the unpriced plan gets zero weight (all goes to the priced one)', () => {
    const planPrices = new Map([['IP-30', 10000]]);
    const shares = attributeCollectedAmountToContracts(
      50000,
      [
        { contractId: 'priced', planCode: 'IP-30' },
        { contractId: 'unpriced', planCode: 'IP-UNKNOWN' },
      ],
      planPrices,
    );
    const priced = shares.find((s) => s.contractId === 'priced')!;
    const unpriced = shares.find((s) => s.contractId === 'unpriced')!;
    expect(priced.amountArs).toBe(50000);
    expect(unpriced.amountArs).toBe(0);
    expect(priced.attributionConfidence).toBe('estimated');
    expect(unpriced.attributionConfidence).toBe('estimated');
  });

  it('no contracts — returns an empty split (caller treats the cash as unattributed, not a crash)', () => {
    expect(attributeCollectedAmountToContracts(1000, [], new Map())).toEqual([]);
  });
});

describe('netCollectedAmountForMonth (design.md Decision 2, comprobante-type netting)', () => {
  const classifications = new Map<string, FinanceInvoiceTypeBucket>([
    ['FB', 'revenue'],
    ['NC', 'contra'],
    ['EX', 'excluded'],
  ]);

  // 3.9
  it('revenue sums, contra subtracts, excluded is ignored, unclassified is excluded from net but tallied separately', () => {
    const result = netCollectedAmountForMonth(
      [
        { amount: 1000, grType: 'FB' }, // revenue: +1000
        { amount: 200, grType: 'NC' }, // contra: -200
        { amount: 500, grType: 'EX' }, // excluded: ignored
        { amount: 77, grType: 'XZ' }, // unclassified: excluded from net, tallied
      ],
      classifications,
    );
    expect(result.netAmount).toBe(800);
    expect(result.unclassifiedAmount).toBe(77);
  });

  it('a grType absent from the classification map is treated as unclassified (auto-alta not yet synced)', () => {
    const result = netCollectedAmountForMonth([{ amount: 42, grType: 'NEVER-SEEN' }], new Map());
    expect(result.netAmount).toBe(0);
    expect(result.unclassifiedAmount).toBe(42);
  });

  it('empty input nets to zero', () => {
    expect(netCollectedAmountForMonth([], classifications)).toEqual({ netAmount: 0, unclassifiedAmount: 0 });
  });
});

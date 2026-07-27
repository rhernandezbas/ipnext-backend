import { buildChainedIndex } from '@application/use-cases/finance/financeInflation';

describe('buildChainedIndex (design.md Decision 3 — chained IPC index)', () => {
  it('4.1 — chains multiplicatively (NOT additively) forward from base, verified against hand-computed numbers', () => {
    // 4%, 3%, 5% month-over-month from the base — the identity this closes over
    // is chainedIndex(2026-04) = 1.04 × 1.03 × 1.05, never 1 + .04 + .03 + .05.
    const rates = new Map([
      ['2026-02', 4],
      ['2026-03', 3],
      ['2026-04', 5],
    ]);
    const { chainedIndexByMonth } = buildChainedIndex('2026-01', '2026-01', '2026-04', rates);

    expect(chainedIndexByMonth.get('2026-01')).toBe(1);
    expect(chainedIndexByMonth.get('2026-02')).toBeCloseTo(1.04, 10);
    expect(chainedIndexByMonth.get('2026-03')).toBeCloseTo(1.04 * 1.03, 10);
    expect(chainedIndexByMonth.get('2026-04')).toBeCloseTo(1.04 * 1.03 * 1.05, 10);
    // Sanity: the multiplicative chain must NOT equal the additive sum (1 + .04+.03+.05 = 1.12).
    expect(chainedIndexByMonth.get('2026-04')).not.toBeCloseTo(1.12, 4);
  });

  it('4.2 — a missing month inside the range truncates the chain there, leaving earlier months reachable', () => {
    const rates = new Map([
      ['2026-02', 4],
      // 2026-03 missing on purpose.
      ['2026-04', 5],
    ]);
    const { chainedIndexByMonth } = buildChainedIndex('2026-01', '2026-01', '2026-04', rates);

    expect(chainedIndexByMonth.has('2026-01')).toBe(true);
    expect(chainedIndexByMonth.has('2026-02')).toBe(true);
    expect(chainedIndexByMonth.has('2026-03')).toBe(false);
    expect(chainedIndexByMonth.has('2026-04')).toBe(false); // never reachable once the chain breaks upstream
  });

  it('fix-wave-4 🔴1 — a gap in EACH direction leaves a NON-CONTIGUOUS set of real months; a single cutoff could never describe this shape (this is the exact reason `truncatedAt` was replaced by reading `chainedIndexByMonth.has(...)` per month)', () => {
    // base=2026-03, requested [2026-01, 2026-06], rates loaded ONLY at 2026-03
    // and 2026-04 (bridging Feb→Mar and Mar→Apr respectively) — the measured
    // review scenario. 2026-02 IS reachable (backward one step from base),
    // 2026-01 is NOT (the next backward step, bridged by the MISSING 2026-02
    // rate, is what breaks the backward walk). 2026-05/06 are NOT reachable
    // (forward walk breaks immediately after base since 2026-05's rate is missing).
    const rates = new Map([
      ['2026-03', 10], // bridges Feb(02) -> Mar(03)
      ['2026-04', 10], // bridges Mar(03) -> Apr(04)
    ]);
    const { chainedIndexByMonth } = buildChainedIndex('2026-03', '2026-01', '2026-06', rates);

    expect(chainedIndexByMonth.has('2026-01')).toBe(false);
    expect(chainedIndexByMonth.has('2026-02')).toBe(true); // a VALUE exists here — a single "truncatedAt: 2026-01" would have hidden this
    expect(chainedIndexByMonth.has('2026-03')).toBe(true); // base
    expect(chainedIndexByMonth.has('2026-04')).toBe(true); // a VALUE exists here too
    expect(chainedIndexByMonth.has('2026-05')).toBe(false);
    expect(chainedIndexByMonth.has('2026-06')).toBe(false);
  });

  it('off-by-one guard: deflating month M must use chainedIndex(M), not chainedIndex(M±1) — verified over 3 chained months', () => {
    const rates = new Map([
      ['2026-02', 10],
      ['2026-03', 10],
      ['2026-04', 10],
    ]);
    const { chainedIndexByMonth } = buildChainedIndex('2026-01', '2026-01', '2026-04', rates);

    const nominal = 1000;
    const realAt = (m: string) => nominal / (chainedIndexByMonth.get(m) as number);

    // Each month's real value must differ from its NEIGHBOR's — an off-by-one
    // bug (reading the wrong month's index) would silently make two adjacent
    // months share a deflator.
    expect(realAt('2026-02')).not.toBeCloseTo(realAt('2026-03'), 2);
    expect(realAt('2026-03')).not.toBeCloseTo(realAt('2026-04'), 2);
    expect(realAt('2026-01')).toBeCloseTo(1000, 8); // base month is never deflated
    expect(realAt('2026-04')).toBeCloseTo(1000 / 1.331, 6); // 1.1^3
  });

  it('backward walk: base AFTER "from" chains correctly toward earlier months', () => {
    const rates = new Map([
      ['2026-02', 4], // bridges 2026-01 → 2026-02
      ['2026-03', 3], // bridges 2026-02 → 2026-03 (== base)
    ]);
    const { chainedIndexByMonth } = buildChainedIndex('2026-03', '2026-01', '2026-03', rates);

    expect(chainedIndexByMonth.get('2026-03')).toBe(1);
    expect(chainedIndexByMonth.get('2026-02')).toBeCloseTo(1 / 1.03, 10);
    expect(chainedIndexByMonth.get('2026-01')).toBeCloseTo(1 / 1.03 / 1.04, 10);
  });

  it('backward gap: a missing rate blocks every earlier month, leaving ONLY the base reachable', () => {
    const rates = new Map([
      // 2026-03 (rate needed to bridge base → 2026-02) missing on purpose.
      ['2026-02', 4],
    ]);
    const { chainedIndexByMonth } = buildChainedIndex('2026-03', '2026-01', '2026-03', rates);

    expect(chainedIndexByMonth.has('2026-02')).toBe(false);
    expect(chainedIndexByMonth.has('2026-01')).toBe(false);
    expect(chainedIndexByMonth.get('2026-03')).toBe(1);
  });
});

import { classifyTech, TechClass } from '@application/use-cases/classifyTech';

describe('classifyTech', () => {
  const cases: Array<{ plan: string | null; expected: TechClass; why: string }> = [
    { plan: '300MB', expected: 'FIBER', why: 'first integer 300 ≥ 100 → FIBER' },
    { plan: '100', expected: 'FIBER', why: 'boundary: exactly 100 → FIBER' },
    { plan: '99MB', expected: 'WIRELESS', why: 'boundary: 99 < 100 → WIRELESS' },
    { plan: '50/25MB', expected: 'WIRELESS', why: 'first integer 50 < 100 → WIRELESS' },
    { plan: '20/5MB GRAL', expected: 'WIRELESS', why: 'first integer is 20 (speed), not 5 → WIRELESS' },
    { plan: 'FIBRA', expected: 'UNCLASSIFIED', why: 'no digits → UNCLASSIFIED' },
    { plan: '', expected: 'UNCLASSIFIED', why: 'empty string → UNCLASSIFIED' },
    { plan: null, expected: 'UNCLASSIFIED', why: 'null plan → UNCLASSIFIED' },
  ];

  it.each(cases)('classifies "$plan" → $expected ($why)', ({ plan, expected }) => {
    expect(classifyTech(plan)).toBe(expected);
  });
});

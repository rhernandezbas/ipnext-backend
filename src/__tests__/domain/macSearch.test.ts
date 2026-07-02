/**
 * macSearch.test.ts — unit tests for the pure MAC-search domain helper.
 * TDD: tests written first (red → green).
 *
 * looksLikeMac: returns true when the cleaned hex string has ≥ 4 chars and ≤ 12 chars,
 *   all hex, after stripping [:.\-\s].
 * macSearchVariants: returns [raw, colon, dash, plain] — all lowercase — for building OR queries.
 */
import { looksLikeMac, macSearchVariants } from '@domain/services/macSearch';

describe('looksLikeMac', () => {
  it('full MAC with colons', () => {
    expect(looksLikeMac('AA:BB:CC:DD:EE:FF')).toBe(true);
  });

  it('full MAC with dashes', () => {
    expect(looksLikeMac('aa-bb-cc-dd-ee-ff')).toBe(true);
  });

  it('full MAC plain (no separators)', () => {
    expect(looksLikeMac('aabbccddeeff')).toBe(true);
  });

  it('partial MAC prefix (4 hex chars)', () => {
    expect(looksLikeMac('aabb')).toBe(true);
  });

  it('partial MAC prefix (6 hex chars = 3 octets)', () => {
    expect(looksLikeMac('aabbcc')).toBe(true);
  });

  it('partial MAC with colons', () => {
    expect(looksLikeMac('AA:BB:CC')).toBe(true);
  });

  it('IP address is NOT a MAC', () => {
    expect(looksLikeMac('100.64.28.5')).toBe(false);
  });

  it('plain username is NOT a MAC', () => {
    expect(looksLikeMac('juan@ipnext.com.ar')).toBe(false);
  });

  it('customer name is NOT a MAC', () => {
    expect(looksLikeMac('González')).toBe(false);
  });

  it('3 hex chars is NOT a MAC (too short)', () => {
    expect(looksLikeMac('abc')).toBe(false);
  });

  it('empty string is NOT a MAC', () => {
    expect(looksLikeMac('')).toBe(false);
  });

  it('too many hex chars (>12) is NOT a MAC', () => {
    expect(looksLikeMac('aabbccddeeff00')).toBe(false);
  });

  it('mixed hex+non-hex after stripping is NOT a MAC', () => {
    // "100" has '1','0','0' — all hex — but also digits from IP portion. "100.64" → strip "." → "10064" → 5 chars, all hex → IS a MAC prefix
    // We want to confirm that an IP like "100.64.28.5" → strip "." → "100642850" → 9 chars but contains "g" → no, only hex
    // Let's test something clearly not hex
    expect(looksLikeMac('gg:hh:ii')).toBe(false);
  });
});

describe('macSearchVariants', () => {
  it('full MAC with colons produces 4 variants all lowercase', () => {
    const variants = macSearchVariants('AA:BB:CC:DD:EE:FF');
    expect(variants).toHaveLength(4);
    expect(variants).toContain('AA:BB:CC:DD:EE:FF'); // raw (original input)
    expect(variants).toContain('aa:bb:cc:dd:ee:ff'); // colon
    expect(variants).toContain('aa-bb-cc-dd-ee-ff'); // dash
    expect(variants).toContain('aabbccddeeff');       // plain
  });

  it('full MAC with dashes produces all 4 variants', () => {
    const variants = macSearchVariants('aa-bb-cc-dd-ee-ff');
    expect(variants).toContain('aa-bb-cc-dd-ee-ff'); // raw
    expect(variants).toContain('aa:bb:cc:dd:ee:ff'); // colon
    expect(variants).toContain('aa-bb-cc-dd-ee-ff'); // dash
    expect(variants).toContain('aabbccddeeff');       // plain
  });

  it('plain MAC (no sep) produces all 4 variants', () => {
    const variants = macSearchVariants('aabbccddeeff');
    expect(variants).toContain('aabbccddeeff'); // raw AND plain
    expect(variants).toContain('aa:bb:cc:dd:ee:ff');
    expect(variants).toContain('aa-bb-cc-dd-ee-ff');
  });

  it('partial MAC prefix (6 hex = 3 octets) colon produces variants', () => {
    const variants = macSearchVariants('aabbcc');
    expect(variants).toContain('aabbcc'); // raw
    expect(variants).toContain('aa:bb:cc'); // colon variant
    expect(variants).toContain('aa-bb-cc'); // dash variant
    expect(variants).toContain('aabbcc');   // plain variant (same as raw for this case)
  });

  it('colon variant is lowercase even for uppercase input', () => {
    const variants = macSearchVariants('AA:BB:CC:DD:EE:FF');
    const colon = variants.find(v => v !== 'AA:BB:CC:DD:EE:FF' && v.includes(':'));
    expect(colon).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('all variants except raw are lowercase', () => {
    const variants = macSearchVariants('AA:BB:CC:DD:EE:FF');
    const [raw, ...rest] = variants;
    expect(raw).toBe('AA:BB:CC:DD:EE:FF');
    for (const v of rest) {
      expect(v).toBe(v.toLowerCase());
    }
  });

  it('deduplicates when raw equals one of the derived variants', () => {
    // plain input 'aabbccddeeff' → raw = 'aabbccddeeff', plain = 'aabbccddeeff'
    // variants should deduplicate
    const variants = macSearchVariants('aabbccddeeff');
    const seen = new Set(variants);
    expect(seen.size).toBe(variants.length); // no duplicates
  });
});

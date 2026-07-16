/**
 * macNormalize.test.ts — unit tests for the pure MAC-address canonicalization helper.
 * TDD: tests written first (red → green).
 *
 * normalizeMac: canonical identity form (12 lowercase hex chars, no separators) used as the
 * JOIN key across callerId / RadiusEvent.macAddress / UispDevice.mac. Different semantics from
 * `@domain/services/macSearch` (partial search, dots NOT stripped) — see macNormalize.ts header.
 */
import { normalizeMac } from '@domain/services/macNormalize';

describe('normalizeMac — valid formats converge', () => {
  it('colon-separated uppercase', () => {
    expect(normalizeMac('AA:BB:CC:DD:EE:FF')).toBe('aabbccddeeff');
  });

  it('dash-separated lowercase', () => {
    expect(normalizeMac('aa-bb-cc-dd-ee-ff')).toBe('aabbccddeeff');
  });

  it('Cisco dot-grouped', () => {
    expect(normalizeMac('aabb.ccdd.eeff')).toBe('aabbccddeeff');
  });

  it('no separators, uppercase', () => {
    expect(normalizeMac('AABBCCDDEEFF')).toBe('aabbccddeeff');
  });
});

describe('normalizeMac — invalid inputs return null', () => {
  it('null', () => {
    expect(normalizeMac(null)).toBeNull();
  });

  it('undefined', () => {
    expect(normalizeMac(undefined)).toBeNull();
  });

  it('empty string', () => {
    expect(normalizeMac('')).toBeNull();
  });

  it('too short (not 12 hex chars)', () => {
    expect(normalizeMac('aa:bb:cc')).toBeNull();
  });

  it('non-hex characters', () => {
    expect(normalizeMac('zz:bb:cc:dd:ee:ff')).toBeNull();
  });

  it('IP address is NOT a valid MAC', () => {
    expect(normalizeMac('100.64.28.5')).toBeNull();
  });
});

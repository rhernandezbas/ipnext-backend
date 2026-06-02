import { normalizeMac, normalizeSn } from '@infrastructure/adapters/ocr/normalizeDeviceFields';

describe('normalizeMac', () => {
  it('canonicalizes 12 hex chars without separators to colon-form uppercase', () => {
    expect(normalizeMac('DC8E8D156CE6')).toBe('DC:8E:8D:15:6C:E6');
  });

  it('keeps a well-formed colon MAC (uppercased)', () => {
    expect(normalizeMac('74:ac:b9:0c:44:4b')).toBe('74:AC:B9:0C:44:4B');
  });

  it('accepts dash separators', () => {
    expect(normalizeMac('74-AC-B9-0C-44-4B')).toBe('74:AC:B9:0C:44:4B');
  });

  it('rejects a truncated MAC (real gemma3 misread: 5 octets)', () => {
    expect(normalizeMac('E0:63:D4:BE:8E')).toBeNull();
  });

  it('rejects a malformed MAC with a 4-char group (real gemma3 misread)', () => {
    expect(normalizeMac('00:24:56:BEA1:92:44')).toBeNull();
  });

  it('rejects too-short and non-hex values', () => {
    expect(normalizeMac('AA:BB')).toBeNull();
    expect(normalizeMac('ZZ:GG:HH:II:JJ:KK')).toBeNull();
  });

  it('treats null/empty/sentinels as null', () => {
    expect(normalizeMac(null)).toBeNull();
    expect(normalizeMac('')).toBeNull();
    expect(normalizeMac('null')).toBeNull();
    expect(normalizeMac('N/A')).toBeNull();
  });
});

describe('normalizeSn', () => {
  it('keeps a plausible serial as-is (trimmed)', () => {
    expect(normalizeSn('SN0300245014A')).toBe('SN0300245014A');
    expect(normalizeSn('1100309242501444')).toBe('1100309242501444');
    expect(normalizeSn('  ABC12  ')).toBe('ABC12');
  });

  it('rejects too-short serials', () => {
    expect(normalizeSn('SN1')).toBeNull();
  });

  it('rejects serials with whitespace or invalid chars', () => {
    expect(normalizeSn('A B C D')).toBeNull();
    expect(normalizeSn('SN!@#$')).toBeNull();
  });

  it('treats null/empty/sentinels as null', () => {
    expect(normalizeSn(null)).toBeNull();
    expect(normalizeSn('')).toBeNull();
    expect(normalizeSn('null')).toBeNull();
    expect(normalizeSn('N/A')).toBeNull();
  });
});

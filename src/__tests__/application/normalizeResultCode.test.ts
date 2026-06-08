import { normalizeResultCode } from '@application/use-cases/normalizeResultCode';

describe('normalizeResultCode', () => {
  it('strips trailing period and lowercases (trailing-period-unit)', () => {
    expect(normalizeResultCode('Cliente Ausente.')).toBe('cliente ausente');
  });

  it('collapses internal whitespace to a single space (internal-whitespace-unit)', () => {
    expect(normalizeResultCode('cliente  ausente')).toBe('cliente ausente');
  });

  it('trims outer whitespace and lowercases', () => {
    expect(normalizeResultCode('  CLIENTE AUSENTE  ')).toBe('cliente ausente');
  });

  it('strips multiple trailing non-alphanumeric characters', () => {
    expect(normalizeResultCode('Cliente Ausente...')).toBe('cliente ausente');
  });

  it('strips trailing period + whitespace combined', () => {
    expect(normalizeResultCode('Cliente Ausente. ')).toBe('cliente ausente');
  });

  it('no-false-collapse: "Alpha" and "Alpha Beta" stay distinct', () => {
    const a = normalizeResultCode('Alpha');
    const b = normalizeResultCode('Alpha Beta');
    expect(a).toBe('alpha');
    expect(b).toBe('alpha beta');
    expect(a).not.toBe(b);
  });

  it('no-false-collapse: distinct codes with internal punctuation stay distinct', () => {
    expect(normalizeResultCode('Reparacion-A')).not.toBe(normalizeResultCode('Reparacion-B'));
  });

  it('preserves internal punctuation that distinguishes codes', () => {
    expect(normalizeResultCode('a/b')).not.toBe(normalizeResultCode('a-b'));
  });

  it('handles empty string', () => {
    expect(normalizeResultCode('')).toBe('');
  });

  it('handles already-normalized string unchanged', () => {
    expect(normalizeResultCode('cliente ausente')).toBe('cliente ausente');
  });
});

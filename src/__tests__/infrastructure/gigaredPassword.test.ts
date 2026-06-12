/**
 * #47h — password policy for Gigared register.
 *
 * Gigared rejects passwords with anything outside [a-z0-9] ("La password solo puede
 * contener letras minusculas y numeros"). The server-side deterministic password (#70:
 * `ip{grClienteId}` padded to 8, #65) and operator-typed ones (ChangeTvPassword) MUST comply.
 */
import {
  GIGARED_PASSWORD_RE,
  isValidGigaredPassword,
} from '@infrastructure/security/gigaredPassword';

describe('#47h GIGARED_PASSWORD_RE — policy alphabet', () => {
  it('GIGARED_PASSWORD_RE only matches lowercase letters and digits', () => {
    expect(GIGARED_PASSWORD_RE.test('abc12345')).toBe(true);
    expect(GIGARED_PASSWORD_RE.test('ABC12345')).toBe(false);
    expect(GIGARED_PASSWORD_RE.test('abc-1234')).toBe(false);
    expect(GIGARED_PASSWORD_RE.test('abc 1234')).toBe(false);
  });
});

describe('#47h isValidGigaredPassword — provided-password validation (8..64)', () => {
  it('accepts a valid lowercase+digit password within length bounds', () => {
    expect(isValidGigaredPassword('abc12345')).toBe(true);
    expect(isValidGigaredPassword('a'.repeat(64))).toBe(true);
  });

  it('rejects uppercase, symbols, and out-of-range lengths', () => {
    expect(isValidGigaredPassword('ABC12345')).toBe(false); // uppercase
    expect(isValidGigaredPassword('abc_1234')).toBe(false); // symbol
    expect(isValidGigaredPassword('abc1234')).toBe(false); // too short (7)
    expect(isValidGigaredPassword('a'.repeat(65))).toBe(false); // too long (65)
    expect(isValidGigaredPassword('')).toBe(false);
  });
});

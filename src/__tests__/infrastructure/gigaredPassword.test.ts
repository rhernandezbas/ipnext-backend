/**
 * #47h — password policy for Gigared register.
 *
 * Gigared rejects passwords with anything outside [a-z0-9] ("La password solo puede
 * contener letras minusculas y numeros"). The server-generated password MUST comply:
 * exactly 12 chars, all in [a-z0-9], cryptographically random (crypto, not Math.random).
 */
import {
  generateGigaredPassword,
  GIGARED_PASSWORD_RE,
  isValidGigaredPassword,
} from '@infrastructure/security/gigaredPassword';

describe('#47h generateGigaredPassword — policy compliance', () => {
  it('produces a 12-char [a-z0-9] string on every one of 1000 generations', () => {
    const re = /^[a-z0-9]{12}$/;
    for (let i = 0; i < 1000; i++) {
      const pw = generateGigaredPassword();
      expect(pw).toMatch(re);
    }
  });

  it('is not deterministic (two consecutive generations differ)', () => {
    expect(generateGigaredPassword()).not.toBe(generateGigaredPassword());
  });

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

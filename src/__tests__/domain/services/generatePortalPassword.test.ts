import { generatePortalPassword } from '@domain/services/generatePortalPassword';

// Letters exclude ambiguous O/0 and I/1 (dictado telefonico) — digits exclude 0/1 too.
const LETTER_SEGMENT = '[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}';
const DIGIT_SEGMENT = '[23456789]{4}';
const FORMAT_RE = new RegExp(`^${LETTER_SEGMENT}-${DIGIT_SEGMENT}-${LETTER_SEGMENT}$`);

describe('generatePortalPassword', () => {
  it('matches the XXXX-9999-XXXX format', () => {
    const password = generatePortalPassword();
    expect(password).toMatch(FORMAT_RE);
  });

  it('never contains ambiguous characters (O, 0, I, 1)', () => {
    for (let i = 0; i < 200; i++) {
      const password = generatePortalPassword();
      expect(password).not.toMatch(/[O0I1]/);
    }
  });

  it('generates non-repeating passwords across many calls (RNG sanity)', () => {
    const passwords = new Set<string>();
    for (let i = 0; i < 500; i++) {
      passwords.add(generatePortalPassword());
    }
    // 500 draws from a huge space (~24^8 * 8^4 combinations) must be all-unique;
    // a constant/broken RNG would collapse this set to size 1.
    expect(passwords.size).toBe(500);
  });

  it('always returns a 14-character string (4+1+4+1+4)', () => {
    expect(generatePortalPassword()).toHaveLength(14);
  });
});

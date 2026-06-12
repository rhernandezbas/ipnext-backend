/**
 * #65 — alta de TV determinística. El email y la password se derivan del cliente GR:
 *   - email    = {apellido normalizado}{idGR}@gmail.com
 *   - password = "ip{idGR}" paddeada con '0' al FINAL hasta min 8 chars.
 * Ambos cumplen la política CUA [a-z0-9] (+ @gmail.com en el email).
 */
import {
  deterministicTvEmail,
  deterministicTvPassword,
  isValidGigaredPassword,
} from '@infrastructure/security/gigaredPassword';

describe('#65 deterministicTvPassword', () => {
  it('builds "ip{idGR}" when already >= 8 chars', () => {
    // ip + 123456 = 8 chars exactly
    expect(deterministicTvPassword('123456')).toBe('ip123456');
  });

  it('pads with trailing 0 up to the 8-char minimum', () => {
    // ip2432 = 6 chars → pad 2 zeros → 8
    expect(deterministicTvPassword('2432')).toBe('ip243200');
  });

  it('pads a single trailing 0 when one char short', () => {
    // ip12345 = 7 → pad 1 → 8
    expect(deterministicTvPassword('12345')).toBe('ip123450');
  });

  it('never pads beyond 8 when the id is long', () => {
    expect(deterministicTvPassword('1234567890')).toBe('ip1234567890');
  });

  it('always satisfies the Gigared CUA policy', () => {
    for (const id of ['1', '24', '243', '2432', '24320', '999999999']) {
      const pw = deterministicTvPassword(id);
      expect(pw.length).toBeGreaterThanOrEqual(8);
      expect(isValidGigaredPassword(pw)).toBe(true);
    }
  });
});

describe('#65 deterministicTvEmail', () => {
  it('builds {lastname}{idGR}@gmail.com lowercased', () => {
    expect(deterministicTvEmail('Ronald', '2432')).toBe('ronald2432@gmail.com');
  });

  it('uses only the FIRST word of a multi-word lastname', () => {
    expect(deterministicTvEmail('De La Cruz', '10')).toBe('de10@gmail.com');
  });

  it('strips accents and maps ñ → n', () => {
    expect(deterministicTvEmail('Núñez', '7')).toBe('nunez7@gmail.com');
    expect(deterministicTvEmail('Peña', '7')).toBe('pena7@gmail.com');
    expect(deterministicTvEmail('Ramírez', '7')).toBe('ramirez7@gmail.com');
  });

  it('drops any non [a-z] char from the lastname', () => {
    expect(deterministicTvEmail("O'Brien", '5')).toBe('obrien5@gmail.com');
    // single hyphenated token (no space): the whole word minus non-[a-z]
    expect(deterministicTvEmail('García-López', '5')).toBe('garcialopez5@gmail.com');
  });

  it('falls back to "cliente" when the lastname normalizes to empty', () => {
    expect(deterministicTvEmail('', '9')).toBe('cliente9@gmail.com');
    expect(deterministicTvEmail('123', '9')).toBe('cliente9@gmail.com');
  });

  it('local-part is CUA-compliant [a-z0-9]', () => {
    const email = deterministicTvEmail('Núñez', '2432');
    const local = email.split('@')[0];
    expect(/^[a-z0-9]+$/.test(local)).toBe(true);
  });
});

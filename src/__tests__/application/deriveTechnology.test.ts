import { deriveTechnology } from '@application/use-cases/deriveTechnology';

describe('deriveTechnology', () => {
  // Manual value wins (non-null technology) ────────────────────────────────
  it('returns the manual technology as-is when set (FTTH + low-speed plan)', () => {
    expect(deriveTechnology('FTTH', '50MB')).toBe('FTTH');
  });

  it('returns the manual technology as-is when set (Fiber)', () => {
    expect(deriveTechnology('Fiber', '300MB')).toBe('Fiber');
  });

  it('returns the manual technology as-is when set (Wireless)', () => {
    expect(deriveTechnology('Wireless', '50/25MB')).toBe('Wireless');
  });

  it('returns the manual technology as-is when set (DOCSIS)', () => {
    expect(deriveTechnology('DOCSIS', '100MB')).toBe('DOCSIS');
  });

  it('returns the manual technology as-is when set (HFC)', () => {
    expect(deriveTechnology('HFC', null)).toBe('HFC');
  });

  it('returns the manual technology as-is when set and plan is null', () => {
    expect(deriveTechnology('Radio', null)).toBe('Radio');
  });

  // Null technology — derive from plan ─────────────────────────────────────
  it('returns "Wireless" for null technology + plan speed < 100', () => {
    expect(deriveTechnology(null, '50/25MB')).toBe('Wireless');
  });

  it('returns "Fiber" for null technology + plan speed >= 100', () => {
    expect(deriveTechnology(null, '300MB')).toBe('Fiber');
  });

  it('returns "Fiber" for null technology + plan exactly "100"', () => {
    expect(deriveTechnology(null, '100')).toBe('Fiber');
  });

  it('returns "Wireless" for null technology + plan "20/5MB GRAL"', () => {
    expect(deriveTechnology(null, '20/5MB GRAL')).toBe('Wireless');
  });

  it('returns null for null technology + plan "TV" (no number)', () => {
    expect(deriveTechnology(null, 'TV')).toBeNull();
  });

  it('returns null for null technology + plan "Sin plan" (no number)', () => {
    expect(deriveTechnology(null, 'Sin plan')).toBeNull();
  });

  it('returns null for null technology + plan ""', () => {
    expect(deriveTechnology(null, '')).toBeNull();
  });

  it('returns null for null technology + null plan', () => {
    expect(deriveTechnology(null, null)).toBeNull();
  });

  // Undefined inputs treated the same as null ───────────────────────────────
  it('returns null for undefined technology + undefined plan', () => {
    expect(deriveTechnology(undefined, undefined)).toBeNull();
  });

  it('returns "Fiber" for undefined technology + "100MB" plan', () => {
    expect(deriveTechnology(undefined, '100MB')).toBe('Fiber');
  });

  it('treats empty string technology as falsy (derives from plan)', () => {
    // Empty string is falsy — should derive from plan
    expect(deriveTechnology('', '300MB')).toBe('Fiber');
  });
});

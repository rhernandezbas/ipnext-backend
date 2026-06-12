/**
 * #47h (e) — the register password must be redacted before it reaches an AuditEvent.
 * The audit middleware already lists 'password' in SENSITIVE_KEYS; this pins it.
 */
import { maskSensitive } from '@infrastructure/http/middleware/auditMutationsMiddleware';

describe('#47h audit redaction of the register password', () => {
  it("masks the 'password' field in a register body before persisting", () => {
    const body = {
      firstName: 'J',
      lastName: 'P',
      email: 'e@x.com',
      cic: '0000001234',
      password: 'lowercase42',
    };
    const masked = maskSensitive(body) as Record<string, unknown>;
    expect(masked['password']).toBe('***');
    expect(JSON.stringify(masked)).not.toContain('lowercase42');
    // non-sensitive fields are preserved
    expect(masked['cic']).toBe('0000001234');
  });

  it("#65 masks the 'tvPassword' field (persisted credential) case-insensitively", () => {
    const masked = maskSensitive({ tvLogin: 'GIGA2432', tvPassword: 'ip243200' }) as Record<string, unknown>;
    expect(masked['tvPassword']).toBe('***');
    expect(masked['tvLogin']).toBe('GIGA2432'); // login is not secret
    expect(JSON.stringify(masked)).not.toContain('ip243200');
  });
});

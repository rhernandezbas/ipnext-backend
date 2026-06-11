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
});

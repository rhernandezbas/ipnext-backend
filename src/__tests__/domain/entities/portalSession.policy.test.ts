import {
  isPortalSessionReused,
  isPortalSessionRevoked,
  isPortalSessionExpired,
  isPortalSessionUsable,
} from '@domain/entities/portalSession.policy';
import type { PortalSession } from '@domain/entities/portalSession';

function makeSession(overrides: Partial<PortalSession> = {}): PortalSession {
  return {
    id: 's1',
    accountId: 'acc-1',
    tokenHash: 'hash',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revokedAt: null,
    rotatedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('portalSession.policy', () => {
  describe('isPortalSessionReused', () => {
    it('true when rotatedAt is set (already used once)', () => {
      expect(isPortalSessionReused(makeSession({ rotatedAt: new Date().toISOString() }))).toBe(true);
    });
    it('false when rotatedAt is null', () => {
      expect(isPortalSessionReused(makeSession())).toBe(false);
    });
  });

  describe('isPortalSessionRevoked', () => {
    it('true when revokedAt is set', () => {
      expect(isPortalSessionRevoked(makeSession({ revokedAt: new Date().toISOString() }))).toBe(true);
    });
    it('false when revokedAt is null', () => {
      expect(isPortalSessionRevoked(makeSession())).toBe(false);
    });
  });

  describe('isPortalSessionExpired', () => {
    it('true when expiresAt is in the past', () => {
      const session = makeSession({ expiresAt: new Date(Date.now() - 1000).toISOString() });
      expect(isPortalSessionExpired(session, Date.now())).toBe(true);
    });
    it('false when expiresAt is in the future', () => {
      const session = makeSession({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect(isPortalSessionExpired(session, Date.now())).toBe(false);
    });
  });

  describe('isPortalSessionUsable', () => {
    it('true for a fresh, non-revoked, non-rotated, non-expired session', () => {
      expect(isPortalSessionUsable(makeSession(), Date.now())).toBe(true);
    });
    it('false when rotated', () => {
      expect(isPortalSessionUsable(makeSession({ rotatedAt: new Date().toISOString() }), Date.now())).toBe(false);
    });
    it('false when revoked', () => {
      expect(isPortalSessionUsable(makeSession({ revokedAt: new Date().toISOString() }), Date.now())).toBe(false);
    });
    it('false when expired', () => {
      const session = makeSession({ expiresAt: new Date(Date.now() - 1000).toISOString() });
      expect(isPortalSessionUsable(session, Date.now())).toBe(false);
    });
  });
});

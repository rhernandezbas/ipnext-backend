import { generatePortalRefreshToken, hashPortalRefreshToken } from '@domain/services/portalRefreshToken';

describe('portalRefreshToken', () => {
  describe('generatePortalRefreshToken', () => {
    it('returns a base64url string (no +, /, or = padding)', () => {
      const token = generatePortalRefreshToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('encodes 32 random bytes (43-char base64url, no padding)', () => {
      const token = generatePortalRefreshToken();
      expect(token).toHaveLength(43);
    });

    it('is different across calls', () => {
      const a = generatePortalRefreshToken();
      const b = generatePortalRefreshToken();
      expect(a).not.toBe(b);
    });
  });

  describe('hashPortalRefreshToken', () => {
    it('is deterministic — same input, same hash', () => {
      const token = generatePortalRefreshToken();
      expect(hashPortalRefreshToken(token)).toBe(hashPortalRefreshToken(token));
    });

    it('different tokens hash differently', () => {
      const a = generatePortalRefreshToken();
      const b = generatePortalRefreshToken();
      expect(hashPortalRefreshToken(a)).not.toBe(hashPortalRefreshToken(b));
    });

    it('never returns the raw token itself', () => {
      const token = generatePortalRefreshToken();
      expect(hashPortalRefreshToken(token)).not.toBe(token);
    });

    it('returns a 64-char lowercase hex sha256 digest', () => {
      const token = generatePortalRefreshToken();
      expect(hashPortalRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});

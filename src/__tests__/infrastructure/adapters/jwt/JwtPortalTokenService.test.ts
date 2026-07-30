import jwt from 'jsonwebtoken';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';

describe('JwtPortalTokenService', () => {
  describe('signAccessToken', () => {
    it('produces a JWT with aud=portal, sub=accountId, clientId claim', () => {
      const service = new JwtPortalTokenService(TEST_SECRET);
      const token = service.signAccessToken({ accountId: 'acc-1', clientId: 'client-1' });
      const decoded = jwt.decode(token) as Record<string, unknown>;
      expect(decoded['aud']).toBe('portal');
      expect(decoded['sub']).toBe('acc-1');
      expect(decoded['clientId']).toBe('client-1');
    });

    it('expires in <= 15 minutes', () => {
      const service = new JwtPortalTokenService(TEST_SECRET);
      const token = service.signAccessToken({ accountId: 'acc-1', clientId: 'client-1' });
      const decoded = jwt.decode(token) as Record<string, unknown>;
      const iat = decoded['iat'] as number;
      const exp = decoded['exp'] as number;
      expect(exp - iat).toBeLessThanOrEqual(15 * 60);
    });
  });

  describe('verifyAccessToken', () => {
    it('round-trips a token signed by the same service', () => {
      const service = new JwtPortalTokenService(TEST_SECRET);
      const token = service.signAccessToken({ accountId: 'acc-1', clientId: 'client-1' });
      const claims = service.verifyAccessToken(token);
      expect(claims).toEqual({ accountId: 'acc-1', clientId: 'client-1' });
    });

    it('returns null for a tampered/invalid token', () => {
      const service = new JwtPortalTokenService(TEST_SECRET);
      expect(service.verifyAccessToken('not-a-jwt')).toBeNull();
    });

    it('returns null for a token signed with a different secret', () => {
      const service = new JwtPortalTokenService(TEST_SECRET);
      const other = new JwtPortalTokenService('a-completely-different-secret!!');
      const token = other.signAccessToken({ accountId: 'acc-1', clientId: 'client-1' });
      expect(service.verifyAccessToken(token)).toBeNull();
    });

    it('returns null for a token WITHOUT aud=portal (e.g. a staff-shaped JWT)', () => {
      const service = new JwtPortalTokenService(TEST_SECRET);
      const staffToken = jwt.sign({ id: 'u1', login: 'x', email: 'x@x.com' }, TEST_SECRET, { expiresIn: 3600 });
      expect(service.verifyAccessToken(staffToken)).toBeNull();
    });

    it('returns null for an expired token', () => {
      const service = new JwtPortalTokenService(TEST_SECRET);
      const expired = jwt.sign({ sub: 'acc-1', clientId: 'client-1', aud: 'portal' }, TEST_SECRET, { expiresIn: -1 });
      expect(service.verifyAccessToken(expired)).toBeNull();
    });
  });
});

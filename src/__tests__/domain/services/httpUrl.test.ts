/**
 * isValidHttpUrl — domain service that hardens link-attachment validation across BOTH
 * write surfaces (internal newsMedia + external news). The old prefix-only regex
 * (/^https?:\/\/.+/i) let stored-injection garbage through: anything after a valid
 * "https://x" passed, including control chars, spaces and broken authorities. This
 * validator parses with `new URL`, requires an http(s) protocol + a non-empty host,
 * and rejects any raw string carrying control chars / whitespace.
 */
import { isValidHttpUrl } from '@domain/services/httpUrl';

describe('isValidHttpUrl', () => {
  describe('rejects (review M1 — stored injection vectors)', () => {
    it.each([
      ['newline + tag', 'https://x\n<script>'],
      ['attribute-break quote', 'https://a.com" onmouseover="x'],
      ['no host', 'https://'],
      ['javascript scheme', 'javascript:alert(1)'],
      ['trailing space', 'https:// '],
    ])('%s → false', (_label, raw) => {
      expect(isValidHttpUrl(raw)).toBe(false);
    });

    it('empty string → false', () => {
      expect(isValidHttpUrl('')).toBe(false);
    });

    it('ftp scheme → false', () => {
      expect(isValidHttpUrl('ftp://nope')).toBe(false);
    });

    it('leading/trailing/embedded control chars → false', () => {
      expect(isValidHttpUrl(' https://example.com')).toBe(false);
      expect(isValidHttpUrl('https://exa mple.com')).toBe(false);
      expect(isValidHttpUrl('https://example.com\t')).toBe(false);
    });
  });

  describe('accepts (legit links)', () => {
    it.each([
      ['bare host', 'https://example.com'],
      ['path + query + fragment', 'https://status.x.com/incidents/42?a=b#c'],
      ['http subdomain path', 'http://sub.dominio.co/path'],
    ])('%s → true', (_label, raw) => {
      expect(isValidHttpUrl(raw)).toBe(true);
    });
  });
});

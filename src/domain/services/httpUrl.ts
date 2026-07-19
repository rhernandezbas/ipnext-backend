/**
 * isValidHttpUrl — the single source of truth for validating a user-supplied link URL
 * across every write surface (internal newsMedia + external news). Replaces the old
 * prefix-only regex (/^https?:\/\/.+/i), which let stored-injection garbage through:
 * anything after a valid "https://x" passed, including control chars, embedded spaces
 * and broken authorities (e.g. `https://x\n<script>`, `https://a.com" onmouseover="x`).
 *
 * Rules (all must hold):
 *   1. `raw` is a string with NO control chars or whitespace (\x00–\x20). This rejects
 *      newlines/tabs/spaces BEFORE parsing — `new URL` tolerates some of them.
 *   2. Parses with `new URL(raw)` (throws → invalid).
 *   3. Protocol is exactly `http:` or `https:` (rejects javascript:, ftp:, data:, …).
 *   4. Hostname is non-empty (rejects `https://` with no authority).
 */
export function isValidHttpUrl(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  // Any ASCII control char or space anywhere in the raw string → reject up-front.
  if (/[\x00-\x20]/.test(raw)) return false;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.hostname === '') return false;

  return true;
}

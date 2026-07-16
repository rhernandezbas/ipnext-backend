/**
 * macNormalize.ts — pure domain helper for MAC-address IDENTITY canonicalization.
 *
 * contract-node-ap-auto-assign (Fase B): the JOIN key between PppoeService.callerId /
 * RadiusEvent.macAddress / UispDevice.mac. Different semantics from `@domain/services/macSearch`:
 *
 *   - `macSearch.looksLikeMac` / `macSearchVariants` — PARTIAL SEARCH tolerance. Dots are
 *     intentionally NOT stripped (a dot means "this is an IP, not a MAC prefix") and short
 *     prefixes (4-12 hex chars) are accepted, because it powers a free-text search box.
 *   - `normalizeMac` (this file) — IDENTITY canonicalization for a join key. Dots ARE stripped
 *     (Cisco-style `aabb.ccdd.eeff` is a legitimate full-MAC format in this domain) and the
 *     result MUST be a COMPLETE MAC (exactly 12 hex chars) or the input is rejected as null.
 *     A partial/prefix string is never a valid identity — only `macSearch` treats prefixes as
 *     meaningful.
 *
 * This is a NEW function — macSearch.ts is intentionally left untouched.
 */

const MAC_SEP_RE = /[:\-.\s]/g;
const FULL_MAC_HEX_RE = /^[0-9a-f]{12}$/;

/**
 * Normalizes a MAC-address-like string to its canonical identity form: 12 lowercase hex
 * characters, no separators. Accepts `:`, `-`, `.` and whitespace as separators (case-mixed).
 * Returns `null` for anything that is not EXACTLY a full 12-hex-char MAC once separators are
 * stripped (null/undefined/empty input, wrong length, non-hex characters).
 */
export function normalizeMac(input: string | null | undefined): string | null {
  if (input == null) return null;
  const canonical = input.replace(MAC_SEP_RE, '').toLowerCase();
  return FULL_MAC_HEX_RE.test(canonical) ? canonical : null;
}

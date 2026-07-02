/**
 * macSearch.ts — pure domain helper for MAC-address search normalization.
 *
 * Used by both PrismaPppoeServiceRepository and InMemoryPppoeServiceRepository so the
 * normalization logic lives in a SINGLE place (domain, no infra deps).
 *
 * Strategy (design Decision 1):
 *  - Detect: `looksLikeMac` — strip separators [:.-\s], check 4–12 hex chars.
 *  - Variants: generate [raw, colon, dash, plain] (all lowercase except raw),
 *    deduplicated, for building OR-contains queries tolerant to any separator format.
 */

// MAC separators are ':' and '-' (and optional whitespace). Dots are NOT stripped because
// they appear in IP addresses — "100.64.28.5" must NOT match as a MAC.
const MAC_SEP_RE = /[:\-\s]/g;
const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Returns true when `search` looks like a MAC address (or MAC prefix):
 * after stripping MAC separators (`:`, `-`, whitespace — NOT `.`), the result
 * is 4–12 hex characters. Dots are intentionally NOT stripped so that IP
 * addresses like "100.64.28.5" are not mistakenly classified as MACs.
 */
export function looksLikeMac(search: string): boolean {
  // Reject early if it contains a dot — that's an IP separator, not a MAC one.
  if (search.includes('.')) return false;
  const cleaned = search.replace(MAC_SEP_RE, '');
  if (cleaned.length < 4 || cleaned.length > 12) return false;
  return HEX_RE.test(cleaned);
}

/**
 * Given a MAC-like search term, returns a deduplicated array of string variants
 * for building OR-contains queries that tolerate different separator formats.
 *
 * Variants (all lowercase except `raw`):
 *  - `raw`: the original input (as typed, to match the exact stored format)
 *  - `colon`: `aa:bb:cc:…` (pairs from the canonical hex, joined by `:`)
 *  - `dash`: `aa-bb-cc-…` (pairs joined by `-`)
 *  - `plain`: `aabbcc…` (no separator, lowercase)
 *
 * For partial inputs (e.g. "aabbcc" = 3 octets) the colon/dash variants use
 * pairs from the canonical hex, giving "aa:bb:cc" / "aa-bb-cc".
 */
export function macSearchVariants(search: string): string[] {
  const canonical = search.replace(MAC_SEP_RE, '').toLowerCase();

  // Split canonical hex into 2-char pairs, then join with separators.
  // For odd-length canonicals the last char is its own "pair" — tolerated for partial matches.
  const pairs: string[] = [];
  for (let i = 0; i < canonical.length; i += 2) {
    pairs.push(canonical.slice(i, i + 2));
  }

  const raw   = search;
  const plain = canonical;
  const colon = pairs.join(':');
  const dash  = pairs.join('-');

  // Deduplicate while preserving order: raw first, then derived variants.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of [raw, colon, dash, plain]) {
    if (!seen.has(v)) {
      seen.add(v);
      result.push(v);
    }
  }
  return result;
}

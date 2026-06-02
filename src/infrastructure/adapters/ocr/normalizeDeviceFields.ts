/**
 * Format validation for the SN/MAC the vision model returns. The model often
 * emits truncated or malformed values (e.g. a 5-octet MAC, or merged groups like
 * "BEA1") that LOOK plausible but are wrong. We reject anything that is not a
 * well-formed value so the confidence/soft-fail downstream is meaningful: an
 * unreadable field becomes `null` (→ stays `pending` for manual entry) instead
 * of polluting the suggestions with garbage. Pure; never throws.
 */

const SEP = /[:\-.\s]/g;

/**
 * Canonicalize a MAC to `XX:XX:XX:XX:XX:XX` (uppercase) when it is exactly 12 hex
 * digits (separators optional). Anything else → null.
 */
export function normalizeMac(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const hex = raw.replace(SEP, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex)) return null;
  return (hex.match(/.{2}/g) as string[]).join(':');
}

/**
 * Sanity-check a serial: trimmed, ≥4 chars, alphanumeric (dashes allowed), no
 * whitespace or symbols. Case is preserved (serials can be case-sensitive).
 * Sentinels ("null"/"N/A") and anything failing the shape → null.
 */
export function normalizeSn(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t || /^(null|n\/a)$/i.test(t)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{3,}$/.test(t)) return null;
  return t;
}

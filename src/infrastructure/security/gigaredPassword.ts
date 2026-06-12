/**
 * Gigared password policy (#47h).
 *
 * Gigared's register endpoint rejects any character outside [a-z0-9]
 * ("La password solo puede contener letras minusculas y numeros").
 *
 * Policy:
 *  - alphabet: [a-z0-9] (36 symbols)
 *  - caller-provided passwords: 8..64 chars, same alphabet
 *
 * #70 (rework) — the random generator was REMOVED and the register form has NO
 * password field: the backend generates the deterministic `ip{grId}` (#65) server-side
 * from the customer's grClienteId. Manual passwords exist only in ChangeTvPassword.
 */
const MIN_LENGTH = 8;
const MAX_LENGTH = 64;

/** Matches a non-empty string of lowercase letters and digits only. */
export const GIGARED_PASSWORD_RE = /^[a-z0-9]+$/;

/**
 * Validate a caller-provided password against the Gigared policy:
 * lowercase letters + digits only, length 8..64.
 */
export function isValidGigaredPassword(value: string): boolean {
  if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) return false;
  return GIGARED_PASSWORD_RE.test(value);
}

// ── #65 — alta de TV determinística ──────────────────────────────────────────

/** Fallback local-part when a last name normalizes to nothing usable. */
const EMAIL_FALLBACK = 'cliente';

/**
 * Normalize the FIRST word of a last name to a CUA-safe [a-z] slug:
 * lowercase, strip accents (NFD → drop combining marks), map ñ → n, keep only [a-z].
 * Returns '' when nothing usable remains (caller applies the fallback).
 */
function normalizeLastName(lastName: string): string {
  const first = lastName.trim().split(/\s+/).filter(Boolean)[0] ?? '';
  return first
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents (á → a)
    .replace(/ñ/g, 'n')
    .replace(/[^a-z]/g, '');
}

/**
 * #65 — deterministic TV account email: `{lastname}{grId}@gmail.com`.
 * The local-part is CUA-compliant [a-z0-9]; the domain is fixed @gmail.com.
 * A last name that normalizes to empty degrades to the `cliente` fallback.
 */
export function deterministicTvEmail(lastName: string, grId: string): string {
  const slug = normalizeLastName(lastName) || EMAIL_FALLBACK;
  return `${slug}${grId}@gmail.com`;
}

/**
 * #65 — deterministic TV account password: `ip{grId}`, right-padded with '0'
 * until it reaches the Gigared minimum length (8). All chars are in [a-z0-9].
 */
export function deterministicTvPassword(grId: string): string {
  return `ip${grId}`.padEnd(MIN_LENGTH, '0');
}

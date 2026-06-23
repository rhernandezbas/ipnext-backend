/**
 * Canonical contract status enum the frontend understands.
 * Mirrors the client-side status union used across the app
 * ('active' | 'inactive' | 'blocked' | 'new' | 'baja').
 */
export type ContractStatus = 'active' | 'inactive' | 'blocked' | 'new' | 'baja';

/** Combining diacritical marks range (U+0300–U+036F), used to strip accents after NFD. */
const DIACRITICS = /[̀-ͯ]/g;

/**
 * Map a Gestión Real (GR) raw `estado` string into the canonical ContractStatus.
 *
 * GR sends contract states as free Spanish text ("Vigente", "Baja", ...). The
 * frontend ONLY understands the canonical enum, so without this mapping every
 * GR contract renders as the literal raw string and falls through the FE's
 * status switch to its default ("inactivo") — the root cause of "all contracts
 * show inactive". For CLIENTS the equivalent mapping already exists
 * (PrismaClientMirrorRepository.mapStatus, by numeric code); CONTRACTS were the
 * gap. See deriveTechnology for the same computed-on-read convention.
 *
 * Matching is by normalized text (lowercase + trim + accent-stripped):
 *   - vigente | activo            → active
 *   - baja                        → baja
 *   - inactivo                    → inactive
 *   - suspendido | bloqueado      → blocked
 *   - already-canonical value     → passthrough (idempotent)
 *
 * This makes the function idempotent: applying it to an already-canonical value
 * is a no-op, so it is safe to call at multiple read seams without double-harm.
 *
 * DEFAULT: 'inactive'. The GR contract `estado` set observed in real captures is
 * short (Vigente / Baja, per gestionReal.ts) but is NOT documented as closed, so
 * an unknown/missing value cannot be ruled out. 'inactive' is the safest default:
 * it never falsely shows a contract as active/usable (fail-closed), matching the
 * client-side mapStatus fallback which also defaults to 'inactive'.
 *
 * OBSERVABILITY: when a NON-EMPTY value falls through to the default, we emit a
 * console.warn with the raw value so an unanticipated GR estado is visible in prod
 * logs (and can be added to the mapping). Empty/null/undefined do NOT warn — those
 * are an expected absence, not an unmapped value.
 *
 * @param grEstado - The raw GR contract estado (or an already-canonical value).
 * @returns The canonical ContractStatus.
 */
export function mapContractStatus(grEstado: string | null | undefined): ContractStatus {
  // Normalize: strip diacritics (NFD decomposition + drop combining marks) + trim + lowercase.
  const normalized = (grEstado ?? '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .trim()
    .toLowerCase();

  switch (normalized) {
    case 'vigente':
    case 'activo':
    case 'active':
      return 'active';
    case 'baja':
      return 'baja';
    case 'inactivo':
    case 'inactive':
      return 'inactive';
    case 'suspendido':
    case 'bloqueado':
    case 'blocked':
      return 'blocked';
    case 'new':
      return 'new';
    default:
      // Unknown but NON-EMPTY value → surface it for prod observability.
      // Empty/null/undefined are an expected absence, not an unmapped estado.
      if (normalized !== '') {
        console.warn(`[mapContractStatus] unmapped GR contract estado: "${grEstado}" -> defaulting to "inactive"`);
      }
      // fail-closed: never show an unknown contract as active/usable.
      return 'inactive';
  }
}

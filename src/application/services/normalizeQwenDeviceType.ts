/**
 * Validates the device-type classification returned by a vision model against
 * a caller-supplied set of active names. Unknown / empty / null → null
 * (NOT 'OTROS': null distinguishes "no match" from "genuinely other"). Pure, no throw.
 *
 * @param raw    Raw string from the model response.
 * @param valid  Set of active type names (UPPERCASE) from the catalog.
 */
export function normalizeQwenDeviceType(raw: string | null | undefined, valid: Set<string>): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const u = raw.trim().toUpperCase();
  return valid.has(u) ? u : null;
}

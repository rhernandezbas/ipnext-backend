/**
 * extractPortalDni — customer-portal-api (Fase 3, task 3.1).
 *
 * `Client.customAttributes` stores the raw GR client payload VERBATIM (see
 * `GestionRealClient.ts` `parseClientsResponse`: `raw: c`, persisted as-is by
 * `PrismaClientMirrorRepository`). GR's JSON is untyped and the `documento` key
 * has been observed as string, number, empty string, or absent — this parser
 * normalizes ALL of those to a single contract: a trimmed non-empty string, or
 * `null` when there is nothing usable.
 *
 * Pure domain: no DB, no network. `CreatePortalAccount` (Fase 3) uses this to
 * resolve the DEFAULT `dni` from the GR mirror when the operator does not pass
 * an explicit override.
 */
export function extractPortalDni(customAttributes: unknown): string | null {
  if (!customAttributes || typeof customAttributes !== 'object') return null;
  const raw = (customAttributes as Record<string, unknown>)['documento'];
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}
